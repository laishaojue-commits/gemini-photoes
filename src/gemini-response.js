/**
 * Helpers for binding a completed response to the request that produced it.
 * These helpers deliberately compare response snapshots instead of treating
 * the composer button becoming idle as proof that a new answer exists.
 */

export function responseFingerprint(response) {
  return JSON.stringify({
    identity: response?.identity || '',
    text: response?.text || '',
    images: (response?.images || []).map(image => image?.src || ''),
  });
}

/**
 * Return a newly appended response, or an error when the snapshot no longer
 * belongs to the same conversation. Existing response nodes are never reused
 * as proof of a new turn.
 */
function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isNewSessionAssignment(baseline, current, prompt) {
  const oldPath = String(baseline?.pathname || '').replace(/\/+$/, '') || '/';
  const newPath = String(current?.pathname || '').replace(/\/+$/, '') || '/';
  if (!/^\/app$/.test(oldPath)
    || !/^\/app\/[^/]+$/.test(newPath)
    || (baseline.responses || []).length !== 0
    || (baseline.userTurnTexts || []).length !== 0
    || (current.userTurnTexts || []).length !== 1) return false;

  const expected = normalizeText(prompt);
  const submitted = (current.userTurnTexts || []).at(-1) || '';
  return !!expected && normalizeText(submitted).includes(expected);
}

export function findNewResponse(baseline, current, { prompt = '', acceptedPageKey = null } = {}) {
  if (!baseline || !current) return { error: 'page_changed' };
  let assignedThisPoll = false;
  if (acceptedPageKey ? current.pageKey !== acceptedPageKey : baseline.pageKey !== current.pageKey) {
    if (!acceptedPageKey && isNewSessionAssignment(baseline, current, prompt)) {
      acceptedPageKey = current.pageKey;
      assignedThisPoll = true;
    } else {
      const oldPath = String(baseline.pathname || '').replace(/\/+$/, '') || '/';
      const newPath = String(current.pathname || '').replace(/\/+$/, '') || '/';
      const pendingAssignment = !acceptedPageKey
        && /^\/app$/.test(oldPath)
        && /^\/app\/[^/]+$/.test(newPath)
        && (baseline.responses || []).length === 0
        && !(current.userTurnTexts || []).length;
      if (pendingAssignment && !(current.responses || []).length) return { awaitingSessionAssignment: true };
      return { error: 'page_changed' };
    }
  }

  const before = baseline.responses || [];
  const after = current.responses || [];
  if (after.length < before.length) return { error: 'page_changed' };

  const sameResponse = (oldResponse, newResponse) => !!newResponse
    && oldResponse.identity === newResponse.identity
    && oldResponse.text === newResponse.text;

  // Normal Gemini behavior appends one model response while preserving the
  // earlier turns. A changed prefix indicates navigation or DOM reordering.
  let prefixStable = true;
  for (let i = 0; i < before.length; i++) {
    if (!sameResponse(before[i], after[i])) {
      prefixStable = false;
      break;
    }
  }
  if (prefixStable && after.length > before.length) {
    return { response: after[before.length], index: before.length, pageKey: current.pageKey };
  }

  if (!prefixStable) return { error: 'page_changed' };
  if (assignedThisPoll) return { pendingPageKey: current.pageKey };
  return null;
}
