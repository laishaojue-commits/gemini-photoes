import { randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';

const SIZE_QUERY_KEYS = new Set([
  'w', 'width', 'h', 'height', 's', 'sz', 'size', 'quality', 'q', 'dpr',
  'resolution', 'resize', 'fit', 'crop', 'scale', 'format', 'fm',
]);
const ID_QUERY_KEYS = new Set([
  'id', 'image_id', 'imageid', 'asset_id', 'assetid', 'file_id', 'fileid',
  'uuid', 'hash', 'resource', 'resource_id', 'key',
]);

/** Normalize common image CDN size variants while retaining resource identity. */
export function normalizeResourceIdentity(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  let pathname = url.pathname;
  pathname = pathname.replace(/(?:=|%3D)(?:s|w|h|c|p|n)?\d+(?:-[wh]\d+)*$/i, '');
  pathname = pathname.replace(/\/(?:w|width|h|height)\/\d+(?=\/|$)/gi, '');

  const params = [...url.searchParams.entries()];
  const stableIds = params
    .filter(([key]) => ID_QUERY_KEYS.has(key.toLowerCase()))
    .map(([key, value]) => [key.toLowerCase(), value])
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
  const retained = stableIds.length
    ? stableIds
    : params
      .filter(([key]) => !SIZE_QUERY_KEYS.has(key.toLowerCase()))
      .map(([key, value]) => [key.toLowerCase(), value])
      .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));

  const query = retained.map(([key, item]) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`).join('&');
  return `https://${url.host}${pathname}${query ? `?${query}` : ''}`;
}

function isEmitter(client) {
  return !!client && typeof client.on === 'function'
    && (typeof client.off === 'function' || typeof client.removeListener === 'function');
}

function safeEventUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:') {
      if (url.origin === 'null') {
        const opaquePath = url.pathname.replace(/^null(?=\/|$)/, '');
        const innerPath = opaquePath.startsWith('/') ? opaquePath : `/${opaquePath}`;
        return `blob:null${innerPath}`;
      }
      return `blob:${url.origin}${url.pathname}`;
    }
    if (url.protocol === 'data:') return 'data:';
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Observe only one download started by the armed click in the selected frame.
 * The returned promise always resolves; callers can safely clean it up on any
 * early exit without producing an unhandled rejection.
 */
export function createDownloadLifecycle(client, { frameId, frameIds = [], imageUrl, resourceUrls = [], timeout = 30_000 } = {}) {
  if (!isEmitter(client)) throw new TypeError('invalid_cdp_event_session');
  if (frameId == null || frameId === '') throw new TypeError('missing_main_frame_id');

  let armed = false;
  let settled = false;
  let timer = null;
  let activeGuid = null;
  let activeBegin = null;
  let sawFrameBegin = false;
  let outcomeError = null;
  let clickStrategy = null;
  let clickDispatch = 'not_attempted';
  const pageFrameIds = new Set([frameId]);
  const pendingFrameParents = new Map();
  const pendingFrameBegins = new Map();
  const pendingProgressEvents = new Map();
  if (frameIds && typeof frameIds[Symbol.iterator] === 'function') {
    for (const id of frameIds) if (typeof id === 'string' && id) pageFrameIds.add(id);
  }
  const diagnostics = {
    beginEvents: 0,
    otherFrameEvents: 0,
    sameFrameEvents: 0,
    pageFrameEvents: 0,
    resourceRejectedEvents: 0,
    resourceMatchedEvents: 0,
    progressEvents: 0,
    lastBegin: null,
  };
  let resolveResult;
  const expectedIdentities = [...new Set([imageUrl, ...resourceUrls]
    .map(normalizeResourceIdentity)
    .filter(Boolean))];
  const beginWaiters = new Set();
  const promise = new Promise(resolvePromise => { resolveResult = resolvePromise; });

  const remove = (eventName, handler) => {
    if (typeof client.off === 'function') client.off(eventName, handler);
    else client.removeListener(eventName, handler);
  };

  const notifyBeginWaiters = (started) => {
    for (const resolveWaiter of beginWaiters) resolveWaiter(started);
    beginWaiters.clear();
  };

  const addFrame = (newFrameId, parentFrameId) => {
    if (typeof newFrameId !== 'string' || !newFrameId) return false;
    if (newFrameId === frameId || pageFrameIds.has(newFrameId)) return true;
    if (typeof parentFrameId !== 'string' || !parentFrameId) return false;
    pendingFrameParents.set(newFrameId, parentFrameId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [candidate, parent] of pendingFrameParents) {
        if (pageFrameIds.has(parent)) {
          pageFrameIds.add(candidate);
          pendingFrameParents.delete(candidate);
          changed = true;
        }
      }
    }
    for (const [guid, pending] of pendingFrameBegins) {
      if (!pageFrameIds.has(pending.event.frameId)) continue;
      pendingFrameBegins.delete(guid);
      diagnostics.otherFrameEvents = Math.max(0, diagnostics.otherFrameEvents - 1);
      processOwnedBegin(pending.event, pending.diagnostic);
      if (!activeGuid || activeGuid !== guid) pendingProgressEvents.delete(guid);
    }
    return pageFrameIds.has(newFrameId);
  };

  const cleanup = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    remove('Browser.downloadWillBegin', onBegin);
    remove('Browser.downloadProgress', onProgress);
    pendingFrameBegins.clear();
    pendingProgressEvents.clear();
    pendingFrameParents.clear();
    notifyBeginWaiters(false);
  };

  const finish = result => {
    if (settled) return;
    settled = true;
    outcomeError = result?.error || null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    notifyBeginWaiters(!!activeGuid);
    resolveResult(result);
  };

  const processProgress = event => {
    if (!activeGuid || event?.guid !== activeGuid) return;
    diagnostics.progressEvents++;
    if (event.state === 'completed') finish({ ok: true, ...activeBegin, filePath: event.filePath || null });
    else if (event.state === 'canceled') finish({ ok: false, error: 'download_canceled', ...activeBegin });
  };

  const processOwnedBegin = (event, beginDiagnostic) => {
    sawFrameBegin = true;
    diagnostics.pageFrameEvents++;
    if (event?.frameId === frameId) diagnostics.sameFrameEvents++;
    beginDiagnostic.frameMatches = true;
    const eventIdentity = normalizeResourceIdentity(event?.url);
    const sourceIsUnmapped = expectedIdentities.length === 0;
    const eventIsUnmapped = eventIdentity == null;
    const resourceMatches = sourceIsUnmapped || eventIsUnmapped
      ? true
      : expectedIdentities.includes(eventIdentity);
    beginDiagnostic.resourceMatches = resourceMatches;
    if (!resourceMatches) {
      diagnostics.resourceRejectedEvents++;
      return;
    }
    diagnostics.resourceMatchedEvents++;
    if (!event?.guid || activeGuid) return;

    // Blob URLs may not expose a comparable resource identity. In that case,
    // ownership by this Page's frame tree plus the armed click is required.
    activeGuid = event.guid;
    activeBegin = {
      guid: event.guid,
      frameId: event.frameId,
      url: event.url || '',
      suggestedFilename: event.suggestedFilename || '',
    };
    notifyBeginWaiters(true);
    const queuedProgress = pendingProgressEvents.get(event.guid);
    if (queuedProgress) {
      pendingProgressEvents.delete(event.guid);
      processProgress(queuedProgress);
    }
  };

  function onBegin(event) {
    if (settled || !armed) return;
    diagnostics.beginEvents++;
    const mainFrameMatches = event?.frameId === frameId;
    const frameMatches = pageFrameIds.has(event?.frameId);
    const beginDiagnostic = {
      frameMatches,
      mainFrameMatches,
      frameId: event?.frameId || null,
      mainFrameId: frameId,
      resourceMatches: null,
      url: safeEventUrl(event?.url),
      suggestedFilename: basename(String(event?.suggestedFilename || '')),
    };
    diagnostics.lastBegin = beginDiagnostic;
    if (!frameMatches) {
      diagnostics.otherFrameEvents++;
      if (event?.guid) pendingFrameBegins.set(event.guid, { event, diagnostic: beginDiagnostic });
      return;
    }
    sawFrameBegin = true;
    processOwnedBegin(event, beginDiagnostic);
  }

  function onProgress(event) {
    if (activeGuid && event?.guid === activeGuid) return processProgress(event);
    if (event?.guid && pendingFrameBegins.has(event.guid)) pendingProgressEvents.set(event.guid, event);
  }

  client.on('Browser.downloadWillBegin', onBegin);
  client.on('Browser.downloadProgress', onProgress);
  timer = setTimeout(() => finish({ ok: false, error: 'download_timeout' }), Math.max(1, timeout));

  return {
    promise,
    arm() { armed = true; },
    get hasStarted() { return activeGuid !== null; },
    get sawFrameBegin() { return sawFrameBegin; },
    get isSettled() { return settled; },
    waitForStart(ms = 250) {
      if (activeGuid) return Promise.resolve(true);
      if (sawFrameBegin || settled) return Promise.resolve(false);
      return new Promise(resolveWaiter => {
        let startTimer;
        const finishWait = started => {
          if (startTimer !== undefined) clearTimeout(startTimer);
          beginWaiters.delete(finishWait);
          resolveWaiter(started);
        };
        beginWaiters.add(finishWait);
        startTimer = setTimeout(() => finishWait(false), Math.max(0, ms));
      });
    },
    cancel(error = 'download_not_started') {
      finish({ ok: false, error });
    },
    addFrame,
    setClickStatus(strategy, status) {
      clickStrategy = strategy;
      clickDispatch = status;
    },
    getDiagnostics() {
      let diagnosis = 'in_progress';
      if (outcomeError === 'download_canceled') diagnosis = 'download_canceled';
      else if (outcomeError === 'download_timeout') {
        if (diagnostics.resourceRejectedEvents > 0 && diagnostics.resourceMatchedEvents === 0) diagnosis = 'resource_rejected';
        else if (diagnostics.beginEvents > 0 && diagnostics.pageFrameEvents === 0) diagnosis = 'frame_mismatch_only';
        else if (diagnostics.resourceMatchedEvents > 0) diagnosis = 'begin_without_completion';
        else if (diagnostics.beginEvents === 0 && clickDispatch === 'dispatched') diagnosis = 'click_dispatched_no_download_event';
        else if (diagnostics.beginEvents === 0) diagnosis = 'no_begin_event';
        else diagnosis = 'no_matching_download_event';
      } else if (settled && !outcomeError) diagnosis = 'download_completed';
      else if (clickDispatch === 'dispatch_error') diagnosis = 'click_dispatch_error';
      return {
        ...diagnostics,
        pageFrameCount: pageFrameIds.size,
        clickStrategy,
        clickDispatch,
        diagnosis,
      };
    },
    cleanup,
  };
}

/** Create an isolated browser download directory and an exclusive finalizer. */
export function createDownloadWorkspace(outputDir) {
  const root = resolve(outputDir);
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, '.gemini-download-'));
  let finalized = false;

  return {
    directory,
    inspect() {
      try {
        return readdirSync(directory, { withFileTypes: true }).map(entry => {
          const path = join(directory, entry.name);
          let size = null;
          if (entry.isFile()) {
            try { size = statSync(path).size; } catch { /* preserve listing if a file disappears */ }
          }
          return { name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size };
        });
      } catch (error) {
        return { error: error?.code || 'download_directory_inspection_failed' };
      }
    },
    finalize({ suggestedFilename, filePath } = {}) {
      if (finalized) return { ok: false, error: 'download_workspace_already_finalized' };
      finalized = true;

      const suggestedBase = basename(String(suggestedFilename || 'gemini-image.png'));
      const extension = extname(suggestedBase).toLowerCase() || '.png';
      const reportedPath = filePath ? resolve(filePath) : '';
      const allowedPrefix = `${resolve(directory)}${sep}`;
      const sourcePath = reportedPath.startsWith(allowedPrefix)
        ? reportedPath
        : join(directory, suggestedBase);
      if (!sourcePath.startsWith(allowedPrefix) || !existsSync(sourcePath)) {
        return { ok: false, error: 'downloaded_file_not_found', filePath: sourcePath };
      }

      for (let attempt = 0; attempt < 5; attempt++) {
        const targetName = `gemini_fullsize_${randomUUID()}${extension}`;
        const targetPath = join(root, targetName);
        try {
          // COPYFILE_EXCL ensures a collision can never overwrite a user's file.
          copyFileSync(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
          unlinkSync(sourcePath);
          try { rmdirSync(directory); } catch { /* keep only non-empty task-owned leftovers */ }
          return { ok: true, filePath: targetPath, suggestedFilename: targetName };
        } catch (error) {
          if (error?.code !== 'EEXIST') return { ok: false, error: error?.message || 'download_move_failed' };
        }
      }
      return { ok: false, error: 'unique_download_name_exhausted' };
    },
  };
}
