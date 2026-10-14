import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import config from '../src/config.js';
import { createDownloadLifecycle, createDownloadWorkspace, normalizeResourceIdentity } from '../src/gemini-download.js';
import { createOps } from '../src/gemini-ops.js';

const FRAME_ID = 'main-frame-fixture';
const IMAGE_URL = 'https://cdn.fixture/images/image-42.png?width=256&height=256';
const FULLSIZE_URL = 'https://cdn.fixture/images/image-42.png?height=2048&width=2048';
const WRONG_URL = 'https://cdn.fixture/images/unrelated.png?width=2048';
const FIXTURE_PNG = await sharp({
  create: { width: 1, height: 1, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
}).png().toBuffer();

function withPageGlobals(document, callback) {
  const values = {
    document,
    location: { href: 'https://gemini.fixture/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try { return callback(); }
  finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

class FixtureButton {
  constructor(card, { x = 420, y = 260, href = '' } = {}) {
    this.card = card;
    this.tagName = 'BUTTON';
    this.href = href;
    this.rect = { left: x, top: y, width: 20, height: 20 };
  }
  getBoundingClientRect() { return this.rect; }
  contains(element) { return element === this; }
  querySelector() { return null; }
  closest() { return null; }
  getAttribute(name) { return name === 'href' ? this.href : null; }
  click() { this.card.fixture.onDomClick?.(this); }
}

class FixtureImage {
  constructor(card, src) {
    this.card = card;
    this.parentElement = card;
    this.src = src;
    this.currentSrc = src;
    this.tagName = 'IMG';
    this.rect = { left: 30, top: 40, width: 320, height: 220 };
  }
  scrollIntoView() {}
  getBoundingClientRect() { return this.rect; }
}

class FixtureCard {
  constructor(fixture, image, buttonOptions) {
    this.fixture = fixture;
    this.parentElement = null;
    this.image = new FixtureImage(this, image.src);
    this.button = buttonOptions === false ? null : new FixtureButton(this, buttonOptions || {});
  }
  querySelectorAll(selector) {
    if (selector === 'img.image.loaded') return [this.image];
    if (/download|mat-icon/i.test(selector)) return this.button ? [this.button] : [];
    return [];
  }
}

class FixtureBody {
  constructor(cards) {
    this.cards = cards;
    this.tagName = 'BODY';
    for (const card of cards) card.parentElement = this;
  }
  querySelectorAll(selector) {
    if (selector === 'img.image.loaded') return this.cards.map(card => card.image);
    if (/download|mat-icon/i.test(selector)) return this.cards.map(card => card.button).filter(Boolean);
    return [];
  }
}

function createFixture({ images = [{ src: IMAGE_URL }], onCoordinateClick, onDomClick, blockCoordinate = false, frameTree } = {}) {
  const fixture = { onCoordinateClick, onDomClick, blockCoordinate, behaviorCalls: [], downloadPath: null, coordinates: [], detachCalls: 0 };
  const cards = images.map((image, index) => new FixtureCard(fixture, image, image.button === false
    ? false
    : { x: image.buttonX ?? 420 + index * 100, y: image.buttonY ?? 260, href: image.downloadUrl || '' }));
  const body = new FixtureBody(cards);
  const document = {
    body,
    querySelectorAll: selector => body.querySelectorAll(selector),
    elementFromPoint: (x, y) => {
      if (fixture.blockCoordinate) return { tagName: 'DIV' };
      return cards.find(card => {
        const rect = card.button?.getBoundingClientRect();
        return rect && x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
      })?.button || null;
    },
  };
  const browserSession = new EventEmitter();
  browserSession.send = async (method, params = {}) => {
    if (method === 'Browser.setDownloadBehavior') {
      fixture.behaviorCalls.push(params);
      if (params.behavior === 'allow') fixture.downloadPath = params.downloadPath;
      return {};
    }
    throw new Error(`unexpected_browser_command:${method}`);
  };
  browserSession.detach = async () => { fixture.detachCalls++; };
  const pageSession = new EventEmitter();
  pageSession.send = async method => {
      if (method === 'Page.enable') return {};
      assert.equal(method, 'Page.getFrameTree');
      return { frameTree: frameTree || { frame: { id: FRAME_ID, url: 'https://gemini.fixture/' } } };
    };
  pageSession.detach = async () => { fixture.detachCalls++; };
  const page = {
    evaluate: async (fn, ...args) => withPageGlobals(document, () => fn(...args)),
    mouse: {
      move: async () => {},
      click: async (x, y) => {
        fixture.coordinates.push({ x, y });
        await fixture.onCoordinateClick?.({ x, y, session: browserSession, fixture });
      },
    },
    browser: () => ({ target: () => ({ createCDPSession: async () => browserSession }) }),
    createCDPSession: async () => pageSession,
  };
  const ops = createOps(page);
  const emitDownload = ({ guid = 'target-guid', url = FULLSIZE_URL, frameId = FRAME_ID, filename = 'same-name.png', state = 'completed' } = {}) => {
    const path = join(fixture.downloadPath, filename);
    writeFileSync(path, FIXTURE_PNG);
    browserSession.emit('Browser.downloadWillBegin', { guid, url, frameId, suggestedFilename: filename });
    if (state) browserSession.emit('Browser.downloadProgress', { guid, state, filePath: path });
    return path;
  };
  return { fixture, ops, browserSession, pageSession, emitDownload, cards };
}

async function withTempOutput(callback) {
  const previous = config.outputDir;
  const outputDir = mkdtempSync(join(tmpdir(), 'gemini-download-tests-'));
  config.outputDir = outputDir;
  try { return await callback(outputDir); }
  finally {
    config.outputDir = previous;
    rmSync(outputDir, { recursive: true, force: true });
  }
}

test('download event watcher binds GUID, selected frame, and normalized image resource', async () => {
  assert.equal(
    normalizeResourceIdentity(IMAGE_URL),
    normalizeResourceIdentity(FULLSIZE_URL),
    'size query variations must preserve resource identity',
  );
  assert.notEqual(normalizeResourceIdentity(IMAGE_URL), normalizeResourceIdentity(WRONG_URL));

  const client = new EventEmitter();
  const lifecycle = createDownloadLifecycle(client, { frameId: FRAME_ID, imageUrl: IMAGE_URL, timeout: 500 });
  lifecycle.arm();
  client.emit('Browser.downloadWillBegin', { guid: 'other-frame', frameId: 'other-frame', url: FULLSIZE_URL });
  client.emit('Browser.downloadWillBegin', { guid: 'wrong-resource', frameId: FRAME_ID, url: WRONG_URL });
  client.emit('Browser.downloadProgress', { guid: 'wrong-resource', state: 'canceled' });
  assert.equal(lifecycle.hasStarted, false);
  client.emit('Browser.downloadWillBegin', { guid: 'target-guid', frameId: FRAME_ID, url: FULLSIZE_URL, suggestedFilename: 'same.png' });
  client.emit('Browser.downloadProgress', { guid: 'other-guid', state: 'canceled' });
  client.emit('Browser.downloadProgress', { guid: 'target-guid', state: 'completed' });
  const result = await lifecycle.promise;
  assert.equal(result.ok, true);
  assert.equal(result.guid, 'target-guid');
  assert.equal(result.url, FULLSIZE_URL);
  const diagnostics = lifecycle.getDiagnostics();
  assert.equal(diagnostics.beginEvents, 3);
  assert.equal(diagnostics.otherFrameEvents, 1);
  assert.equal(diagnostics.resourceRejectedEvents, 1);
  assert.equal(diagnostics.resourceMatchedEvents, 1);
  assert.equal(diagnostics.lastBegin.url, 'https://cdn.fixture/images/image-42.png');
  assert.equal(JSON.stringify(diagnostics).includes('width='), false);
  lifecycle.cleanup();
  assert.equal(client.listenerCount('Browser.downloadWillBegin'), 0);
  assert.equal(client.listenerCount('Browser.downloadProgress'), 0);
});

test('same-frame event with a different URL is rejected rather than bound to the image', async () => {
  const client = new EventEmitter();
  const lifecycle = createDownloadLifecycle(client, { frameId: FRAME_ID, imageUrl: IMAGE_URL, timeout: 30 });
  lifecycle.arm();
  client.emit('Browser.downloadWillBegin', { guid: 'wrong-resource', frameId: FRAME_ID, url: WRONG_URL });
  client.emit('Browser.downloadProgress', { guid: 'wrong-resource', state: 'completed' });
  const result = await lifecycle.promise;
  assert.equal(result.error, 'download_timeout');
  assert.equal(lifecycle.hasStarted, false);
  assert.equal(lifecycle.getDiagnostics().diagnosis, 'resource_rejected');
  assert.equal(lifecycle.getDiagnostics().lastBegin.url, 'https://cdn.fixture/images/unrelated.png');
  lifecycle.cleanup();
  assert.equal(client.listenerCount('Browser.downloadProgress'), 0);
});

test('initial and dynamically attached child frames are accepted; foreign page frames stay excluded', async () => {
  const client = new EventEmitter();
  const lifecycle = createDownloadLifecycle(client, {
    frameId: FRAME_ID,
    frameIds: [FRAME_ID, 'initial-child-frame'],
    imageUrl: 'blob:https://gemini.fixture/preview',
    timeout: 200,
  });
  assert.equal(lifecycle.addFrame('foreign-child-frame', 'foreign-page-frame'), false);
  lifecycle.arm();
  client.emit('Browser.downloadWillBegin', {
    guid: 'foreign-guid', frameId: 'foreign-child-frame', url: 'blob:null/foreign-id',
  });
  client.emit('Browser.downloadProgress', { guid: 'foreign-guid', state: 'completed' });
  client.emit('Browser.downloadWillBegin', {
    guid: 'owned-guid', frameId: 'nested-child-frame', url: 'blob:null/owned-id', suggestedFilename: 'owned.jpg',
  });
  client.emit('Browser.downloadProgress', { guid: 'owned-guid', state: 'completed' });
  assert.equal(lifecycle.hasStarted, false);
  assert.equal(lifecycle.addFrame('nested-child-frame', 'initial-child-frame'), true);
  assert.equal(lifecycle.hasStarted, true);
  const result = await lifecycle.promise;
  assert.equal(result.ok, true);
  assert.equal(result.guid, 'owned-guid');
  assert.equal(lifecycle.getDiagnostics().otherFrameEvents, 1);
  assert.equal(lifecycle.getDiagnostics().pageFrameEvents, 1);
  assert.equal(lifecycle.getDiagnostics().lastBegin.url, 'blob:null/owned-id');
  lifecycle.cleanup();
  assert.equal(client.listenerCount('Browser.downloadWillBegin'), 0);
  assert.equal(client.listenerCount('Browser.downloadProgress'), 0);
});

test('coordinate click triggers one download and an early completed event is retained', async () => {
  await withTempOutput(async outputDir => {
    let domClicks = 0;
    const { fixture, ops, emitDownload } = createFixture({
      onCoordinateClick: () => emitDownload(),
      onDomClick: () => { domClicks++; },
    });
    const result = await ops.downloadFullSizeImage({ imageUrl: IMAGE_URL, timeout: 500 });
    assert.equal(result.ok, true);
    assert.equal(result.index, 0);
    assert.equal(fixture.coordinates.length, 1);
    assert.equal(domClicks, 0);
    assert.deepEqual(fixture.behaviorCalls.map(call => call.behavior), ['allow', 'default']);
    assert.equal(fixture.detachCalls, 2);
    assert.equal(readFileSync(result.filePath).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
    assert.equal(result.filePath.startsWith(outputDir), true);
  });
});

test('DOM strategy is selected before dispatch when hit target obscures the scoped button', async () => {
  await withTempOutput(async () => {
    let domClicks = 0;
    let beginEvents = 0;
    let harness;
    harness = createFixture({
      images: [
        { src: 'https://cdn.fixture/images/old.png', buttonX: 101 },
        { src: IMAGE_URL, buttonX: 808 },
      ],
      onCoordinateClick: () => {},
      blockCoordinate: true,
      onDomClick: () => {
        domClicks++;
        harness.emitDownload({ guid: 'fallback-guid' });
      },
    });
    harness.browserSession.on('Browser.downloadWillBegin', () => { beginEvents++; });
    const result = await harness.ops.downloadFullSizeImage({ index: 1, imageUrl: IMAGE_URL, timeout: 900 });
    assert.equal(result.ok, true);
    assert.deepEqual(harness.fixture.coordinates, []);
    assert.equal(domClicks, 1);
    assert.equal(beginEvents, 1);
  });
});

test('a delayed begin beyond the former retry window still produces only one click', async () => {
  await withTempOutput(async () => {
    let domClicks = 0;
    let harness;
    harness = createFixture({
      onCoordinateClick: () => {
        setTimeout(() => harness.emitDownload({ guid: 'delayed-guid' }), 1_100);
      },
      onDomClick: () => { domClicks++; },
    });
    const result = await harness.ops.downloadFullSizeImage({ imageUrl: IMAGE_URL, timeout: 2_000 });
    assert.equal(result.ok, true);
    assert.equal(harness.fixture.coordinates.length, 1);
    assert.equal(domClicks, 0);
    assert.equal(harness.browserSession.listenerCount('Browser.downloadWillBegin'), 0);
    assert.deepEqual(harness.fixture.behaviorCalls.map(call => call.behavior), ['allow', 'default']);
  });
});

test('Browser begin/progress racing ahead of dynamic frameAttached is resolved only after Page ownership', async () => {
  await withTempOutput(async () => {
    let harness;
    harness = createFixture({
      onCoordinateClick: ({ session }) => {
        session.emit('Browser.downloadWillBegin', {
          guid: 'foreign-guid', frameId: 'foreign-page-frame', url: 'blob:null/foreign-id', suggestedFilename: 'foreign.jpg',
        });
        session.emit('Browser.downloadProgress', { guid: 'foreign-guid', state: 'completed' });
        const filePath = harness.emitDownload({ guid: 'owned-child-guid', frameId: 'download-child-frame', state: null });
        session.emit('Browser.downloadProgress', { guid: 'owned-child-guid', state: 'completed', filePath });
        harness.pageSession.emit('Page.frameAttached', { frameId: 'download-child-frame', parentFrameId: FRAME_ID });
      },
    });
    const result = await harness.ops.downloadFullSizeImage({ imageUrl: IMAGE_URL, timeout: 500 });
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.otherFrameEvents, 1);
    assert.equal(result.diagnostics.pageFrameEvents, 1);
    assert.equal(result.diagnostics.lastBegin.mainFrameMatches, false);
    assert.equal(result.diagnostics.lastBegin.frameMatches, true);
    assert.equal(harness.pageSession.listenerCount('Page.frameAttached'), 0);
    assert.equal(harness.pageSession.listenerCount('Page.frameNavigated'), 0);
  });
});

test('image URL selects only its scoped card button, not an older page button', async () => {
  await withTempOutput(async () => {
    const { fixture, ops, emitDownload } = createFixture({
      images: [
        { src: 'https://cdn.fixture/images/old.png', buttonX: 101 },
        { src: IMAGE_URL, buttonX: 808 },
      ],
      onCoordinateClick: () => emitDownload(),
    });
    const result = await ops.downloadFullSizeImage({ index: 1, imageUrl: IMAGE_URL, timeout: 500 });
    assert.equal(result.ok, true);
    assert.deepEqual(fixture.coordinates, [{ x: 818, y: 270 }]);
    assert.equal(result.index, 1);
  });
});

test('button absence installs no listeners and creates no unhandled rejection', async () => {
  await withTempOutput(async () => {
    const { fixture, ops, browserSession } = createFixture({ images: [{ src: IMAGE_URL, button: false }] });
    const rejections = [];
    const onUnhandled = error => rejections.push(error?.message || String(error));
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await ops.downloadFullSizeImage({ imageUrl: IMAGE_URL, timeout: 25 });
      await new Promise(resolve => setTimeout(resolve, 45));
      assert.equal(result.error, 'full_size_download_btn_not_found');
      assert.equal(fixture.behaviorCalls.length, 0);
      assert.equal(browserSession.listenerCount('Browser.downloadWillBegin'), 0);
      assert.equal(browserSession.listenerCount('Browser.downloadProgress'), 0);
      assert.deepEqual(rejections, []);
    } finally { process.off('unhandledRejection', onUnhandled); }
  });
});

test('timeout and canceled paths clean listeners, consume the promise, and restore browser behavior', async () => {
  await withTempOutput(async () => {
    let timeoutDomClicks = 0;
    const timeoutFixture = createFixture({ onCoordinateClick: () => {}, onDomClick: () => { timeoutDomClicks++; } });
    const timeoutResult = await timeoutFixture.ops.downloadFullSizeImage({ imageUrl: IMAGE_URL, timeout: 35 });
    assert.equal(timeoutResult.error, 'download_timeout');
    assert.equal(timeoutResult.diagnostics.diagnosis, 'click_dispatched_no_download_event');
    assert.equal(timeoutResult.diagnostics.beginEvents, 0);
    assert.equal(timeoutResult.diagnostics.clickDispatch, 'dispatched');
    assert.equal(timeoutResult.diagnostics.downloadDirectory, timeoutFixture.fixture.downloadPath);
    assert.deepEqual(timeoutResult.diagnostics.downloadDirectoryEntries, []);
    assert.equal(timeoutFixture.fixture.coordinates.length, 1);
    assert.equal(timeoutDomClicks, 0);
    assert.equal(timeoutFixture.browserSession.listenerCount('Browser.downloadWillBegin'), 0);
    assert.equal(timeoutFixture.browserSession.listenerCount('Browser.downloadProgress'), 0);
    assert.equal(timeoutFixture.pageSession.listenerCount('Page.frameAttached'), 0);
    assert.equal(timeoutFixture.pageSession.listenerCount('Page.frameNavigated'), 0);
    assert.deepEqual(timeoutFixture.fixture.behaviorCalls.map(call => call.behavior), ['allow', 'default']);

    const canceledFixture = createFixture({
      onCoordinateClick: ({ fixture, session }) => {
        const path = join(fixture.downloadPath, 'same-name.png');
        writeFileSync(path, 'canceled partial');
        session.emit('Browser.downloadWillBegin', { guid: 'cancelled-guid', frameId: FRAME_ID, url: FULLSIZE_URL, suggestedFilename: 'same-name.png' });
        session.emit('Browser.downloadProgress', { guid: 'cancelled-guid', state: 'canceled' });
      },
    });
    const canceledResult = await canceledFixture.ops.downloadFullSizeImage({ imageUrl: IMAGE_URL, timeout: 500 });
    assert.equal(canceledResult.error, 'download_canceled');
    assert.equal(canceledResult.diagnostics.diagnosis, 'download_canceled');
    assert.equal(canceledResult.diagnostics.downloadDirectoryEntries.length, 1);
    assert.match(canceledResult.diagnostics.downloadDirectoryEntries[0].name, /same-name\.png$/);
    assert.ok(canceledResult.downloadDir);
    assert.equal(canceledFixture.browserSession.listenerCount('Browser.downloadProgress'), 0);
    assert.deepEqual(canceledFixture.fixture.behaviorCalls.map(call => call.behavior), ['allow', 'default']);
  });
});

test('same suggested filename is isolated and an existing user file is never overwritten', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'gemini-download-files-'));
  const userFile = join(outputDir, 'same-name.png');
  writeFileSync(userFile, 'user-owned');
  try {
    const results = [];
    for (const payload of ['first', 'second']) {
      const workspace = createDownloadWorkspace(outputDir);
      writeFileSync(join(workspace.directory, 'same-name.png'), payload);
      results.push(workspace.finalize({ suggestedFilename: 'same-name.png' }));
    }
    assert.ok(results.every(result => result.ok));
    assert.notEqual(results[0].filePath, results[1].filePath);
    assert.equal(readFileSync(userFile, 'utf8'), 'user-owned');
    assert.equal(readFileSync(results[0].filePath, 'utf8'), 'first');
    assert.equal(readFileSync(results[1].filePath, 'utf8'), 'second');
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});

test('missing or mismatched image URL never falls back to an old image', async () => {
  const { fixture, ops } = createFixture({ images: [{ src: IMAGE_URL }, { src: WRONG_URL }] });
  const missing = await ops.downloadFullSizeImage({ imageUrl: 'https://cdn.fixture/images/not-present.png' });
  assert.equal(missing.error, 'image_not_found');
  const mismatched = await ops.downloadFullSizeImage({ index: 0, imageUrl: WRONG_URL });
  assert.equal(mismatched.error, 'image_index_mismatch');
  assert.equal(fixture.coordinates.length, 0);
  const invalid = await ops.downloadFullSizeImage({ imageUrl: 'not a URL' });
  assert.equal(invalid.error, 'invalid_image_url');
  const outOfRange = await ops.downloadFullSizeImage({ index: 7, imageUrl: IMAGE_URL });
  assert.equal(outOfRange.error, 'index_out_of_range');
});

test('exception after listener setup cancels its wait, removes listeners, and restores default behavior', async () => {
  await withTempOutput(async () => {
    const { fixture, ops, browserSession } = createFixture({ onCoordinateClick: () => { throw new Error('fixture_click_failed'); } });
    const result = await ops.downloadFullSizeImage({ imageUrl: IMAGE_URL, timeout: 500 });
    assert.equal(result.error, 'fixture_click_failed');
    assert.equal(browserSession.listenerCount('Browser.downloadWillBegin'), 0);
    assert.equal(browserSession.listenerCount('Browser.downloadProgress'), 0);
    assert.deepEqual(fixture.behaviorCalls.map(call => call.behavior), ['allow', 'default']);
  });
});

test('unmapped blob preview conservatively binds the first same-frame event after the scoped click', async () => {
  const client = new EventEmitter();
  const lifecycle = createDownloadLifecycle(client, { frameId: FRAME_ID, imageUrl: 'blob:https://gemini.fixture/preview', timeout: 200 });
  lifecycle.arm();
  client.emit('Browser.downloadWillBegin', { guid: 'another-frame', frameId: 'other', url: FULLSIZE_URL });
  client.emit('Browser.downloadWillBegin', { guid: 'target-guid', frameId: FRAME_ID, url: FULLSIZE_URL, suggestedFilename: 'image.png' });
  client.emit('Browser.downloadProgress', { guid: 'target-guid', state: 'completed' });
  const result = await lifecycle.promise;
  assert.equal(result.ok, true);
  assert.equal(result.guid, 'target-guid');
  lifecycle.cleanup();
});
