import assert from 'node:assert/strict';
import test from 'node:test';
import { createOps } from '../src/gemini-ops.js';

class FixtureNode {
  constructor(tagName, { attrs = {}, className = '', text = '', src = '', complete = true, naturalWidth = 128, naturalHeight = 128 } = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value: String(value) }));
    this.className = className;
    this.innerText = text;
    this.textContent = text;
    this.src = src;
    this.currentSrc = src;
    this.complete = complete;
    this.naturalWidth = naturalWidth;
    this.naturalHeight = naturalHeight;
    this.children = [];
    this.parentElement = null;
    this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
    this.id = attrs.id || '';
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    return this.attributes.find(attr => attr.name === name)?.value || null;
  }

  descendants() {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }

  querySelectorAll(selector) {
    const nodes = this.descendants();
    if (selector === 'img') return nodes.filter(node => node.tagName === 'IMG');
    if (selector === 'div.response-content') return nodes.filter(node => node.tagName === 'DIV' && node.classList.contains('response-content'));
    if (selector === 'img.image.loaded') return nodes.filter(node => node.tagName === 'IMG' && node.classList.contains('image') && node.classList.contains('loaded'));
    if (selector === 'div.loader.animate') return nodes.filter(node => node.tagName === 'DIV' && node.classList.contains('loader') && node.classList.contains('animate'));
    return [];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FixtureDocument extends FixtureNode {
  constructor() {
    super('document');
    this.body = this.append(new FixtureNode('body'));
    this.main = this.body.append(new FixtureNode('main'));
    this.referenceArea = this.main.append(new FixtureNode('div', { attrs: { id: 'composer-reference-area' } }));
  }

  querySelectorAll(selector) {
    if (selector === 'user-query' || selector === '[data-test-id="user-query"]' || selector === '[data-test-id*="user-query"]') {
      return this.body.descendants().filter(node => node.tagName === 'USER-QUERY');
    }
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector) {
    if (selector === 'main') return this.main;
    if (selector === '[data-test-id="chat-history"]') return null;
    return null;
  }

  addTurn(id, text, images = []) {
    const turn = this.main.append(new FixtureNode('section', { attrs: { 'data-test-id': 'model-response', id: `turn-${id}` } }));
    turn.append(new FixtureNode('div', { attrs: { id: `response-${id}` }, className: 'response-content', text }));
    for (const image of images) turn.append(image);
    return turn;
  }

  addUserTurn(text) {
    return this.main.append(new FixtureNode('user-query', { attrs: { 'data-test-id': 'user-query' }, text }));
  }
}

function image(src, { loaded = true, animate = false } = {}) {
  return new FixtureNode('img', {
    src,
    complete: loaded,
    naturalWidth: loaded ? 128 : 0,
    naturalHeight: loaded ? 128 : 0,
    className: `image${loaded ? ' loaded' : ''}${animate ? ' animate' : ''}`,
  });
}

function fixture({ turns = [], statuses = ['mic', 'mic'], onClick, pageUrl = 'https://gemini.google.com/app/session-1' } = {}) {
  const doc = new FixtureDocument();
  for (const turn of turns) doc.addTurn(turn.id, turn.text, turn.images || []);
  globalThis.document = doc;
  globalThis.location = { href: pageUrl, origin: 'https://gemini.google.com', pathname: '/app/session-1', search: '', hash: '' };

  let closed = false;
  const page = { evaluate: async (fn, ...args) => fn(...args), isClosed: () => closed };
  const ops = createOps(page);
  ops.fillPrompt = async () => ({ ok: true });
  ops.click = async () => { await onClick?.(doc); return { ok: true }; };
  let composerStateCalls = 0;
  ops.getStatus = async () => ({ status: composerStateCalls++ < 2 ? 'mic' : 'submit' });
  let poll = 0;
  ops.pollStatus = async () => ({ status: statuses[Math.min(poll++, statuses.length - 1)] || 'mic' });
  return { doc, ops, closePage: () => { closed = true; } };
}

const sendOptions = { timeout: 500, interval: 0, preSendDelay: 0 };

test('mic without a new response never reports success', async () => {
  const { ops } = fixture({ turns: [{ id: 'old', text: 'old answer' }] });
  const result = await ops.sendAndWait('new prompt', { ...sendOptions, timeout: 40 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
});

test('normal reply waits through stop and returns stable new text', async () => {
  const { ops } = fixture({
    turns: [{ id: 'old', text: 'old answer' }],
    statuses: ['stop', 'stop', 'mic', 'mic'],
    onClick: doc => doc.addTurn('new', 'fresh answer'),
  });
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'fresh answer');
  assert.equal(result.responseIndex, 1);
});

test('fast reply can skip stop when the new response itself is stable', async () => {
  const { ops } = fixture({
    turns: [{ id: 'old', text: 'old answer' }],
    statuses: ['mic', 'mic'],
    onClick: doc => doc.addTurn('new', 'fast answer'),
  });
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'fast answer');
});

test('response text is not returned until a changing stream has stabilized', async () => {
  const { ops, doc } = fixture({
    statuses: ['mic', 'mic', 'mic', 'mic'],
    onClick: fixtureDoc => fixtureDoc.addTurn('new', 'part one'),
  });
  let poll = 0;
  ops.pollStatus = async () => {
    const response = doc.querySelectorAll('div.response-content').at(-1);
    if (poll++ === 1) response.innerText = 'part two';
    return { status: 'mic' };
  };
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'part two');
});

test('new text response with an old animated image returns NO_NEW_IMAGE', async () => {
  let extracted = false;
  const { ops } = fixture({
    turns: [{ id: 'old', text: 'old answer', images: [image('old-image', { animate: true })] }],
    onClick: doc => doc.addTurn('new', 'text only'),
  });
  ops.extractImageBase64 = async () => { extracted = true; return { ok: true, dataUrl: 'data:image/png;base64,AA==' }; };
  const result = await ops.generateImage('new prompt', { ...sendOptions, timeout: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_NEW_IMAGE');
  assert.equal(extracted, false);
});

test('old animate does not override the new response image', async () => {
  let extracted;
  const { ops } = fixture({
    turns: [{ id: 'old', text: 'old answer', images: [image('old-animated', { animate: true })] }],
    onClick: doc => doc.addTurn('new', '', [image('new-output')]),
  });
  ops.extractImageBase64 = async src => { extracted = src; return { ok: true, method: 'fixture', dataUrl: 'data:image/png;base64,AA==' }; };
  const result = await ops.generateImage('new prompt', { ...sendOptions, timeout: 500 });
  assert.equal(result.ok, true);
  assert.equal(extracted, 'new-output');
});

test('multiple images are selected from this response, not the page tail', async () => {
  let extracted;
  const { ops } = fixture({
    turns: [{ id: 'old', text: 'old answer', images: [image('old-image')] }],
    onClick: doc => {
      doc.addTurn('new', '', [image('new-first'), image('new-last')]);
      doc.main.append(image('unrelated-page-tail'));
    },
  });
  ops.extractImageBase64 = async src => { extracted = src; return { ok: true, method: 'fixture', dataUrl: 'data:image/png;base64,AA==' }; };
  const result = await ops.generateImage('new prompt', { ...sendOptions, timeout: 500 });
  assert.equal(result.ok, true);
  assert.equal(extracted, 'new-last');
});

test('full-size download receives the selected response image URL and global index', async () => {
  let downloadArgs;
  const { ops } = fixture({
    turns: [{ id: 'old', text: 'old answer', images: [image('old-image')] }],
    onClick: doc => doc.addTurn('new', '', [image('new-image')]),
  });
  ops.downloadFullSizeImage = async args => { downloadArgs = args; return { ok: true, filePath: 'fixture.png' }; };
  const result = await ops.generateImage('new prompt', { ...sendOptions, fullSize: true });
  assert.equal(result.ok, true);
  assert.equal(downloadArgs.index, 1);
  assert.equal(downloadArgs.imageUrl, 'new-image');
  assert.ok(downloadArgs.timeout > 0);
});

test('image loading is awaited based on loaded state and yields the loaded global index', async () => {
  let extracted;
  let delayedImage;
  const { ops } = fixture({
    turns: [{ id: 'old', text: 'old answer', images: [image('old-image')] }],
    onClick: doc => {
      delayedImage = image('delayed-image', { loaded: false });
      doc.addTurn('new', '', [delayedImage]);
      setTimeout(() => {
        delayedImage.complete = true;
        delayedImage.naturalWidth = 128;
        delayedImage.naturalHeight = 128;
        delayedImage.className += ' loaded';
      }, 40);
    },
  });
  ops.extractImageBase64 = async src => { extracted = src; return { ok: true, method: 'fixture', dataUrl: 'data:image/png;base64,AA==' }; };
  const result = await ops.generateImage('new prompt', { ...sendOptions, interval: 1, timeout: 800 });
  assert.equal(result.ok, true);
  assert.equal(extracted, 'delayed-image');
  const snapshot = await ops.getResponseSnapshot();
  const response = snapshot.responses.at(-1);
  const selected = await ops.getResponseImages({ index: response.index, identity: response.identity, pageKey: snapshot.pageKey });
  assert.equal(selected.images[0].index, 1);
});

test('image load timeout is explicit and does not extract an incomplete preview', async () => {
  let extracted = false;
  const { ops } = fixture({ onClick: doc => doc.addTurn('new', '', [image('stuck-image', { loaded: false })]) });
  ops.extractImageBase64 = async () => { extracted = true; return { ok: true }; };
  const result = await ops.generateImage('new prompt', { ...sendOptions, timeout: 90 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'image_load_timeout');
  assert.equal(extracted, false);
});

test('conversation identity change after send is reported, not bound to a new page', async () => {
  const { ops } = fixture({ onClick: () => { globalThis.location.href = 'https://gemini.google.com/app/session-2'; } });
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'page_changed');
});

test('page closure after submit returns page_closed', async () => {
  const { ops, closePage } = fixture();
  ops.click = async () => { closePage(); return { ok: true }; };
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'page_closed');
});

test('blank /app may acquire its first session identity only after this prompt appears', async () => {
  const { ops } = fixture({ pageUrl: 'https://gemini.google.com/app' });
  globalThis.location.pathname = '/app';
  ops.click = async () => {
    globalThis.location.href = 'https://gemini.google.com/app/new-session';
    globalThis.location.pathname = '/app/new-session';
    document.addUserTurn('new prompt');
    document.addTurn('new', 'reply in new session');
    return { ok: true };
  };
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'reply in new session');
  assert.equal(result.responsePageKey, globalThis.location.href + '|main');
});

test('blank /app does not accept navigation into an unrelated existing conversation', async () => {
  const { ops } = fixture({ pageUrl: 'https://gemini.google.com/app' });
  globalThis.location.pathname = '/app';
  ops.click = async () => {
    globalThis.location.href = 'https://gemini.google.com/app/existing-session';
    globalThis.location.pathname = '/app/existing-session';
    document.addUserTurn('unrelated old prompt');
    document.addTurn('existing', 'unrelated old answer');
    return { ok: true };
  };
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'page_changed');
});

test('blank /app cannot bind a newly loaded conversation without this prompt as its user turn', async () => {
  const { ops } = fixture({ pageUrl: 'https://gemini.google.com/app' });
  globalThis.location.pathname = '/app';
  ops.click = async () => {
    globalThis.location.href = 'https://gemini.google.com/app/existing-session';
    globalThis.location.pathname = '/app/existing-session';
    document.addTurn('existing', 'unrelated old answer');
    return { ok: true };
  };
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'page_changed');
});

test('a reused historical response changing later is not treated as a new turn', async () => {
  const { doc, ops } = fixture({ turns: [{ id: 'old', text: 'old answer' }] });
  ops.click = async () => {
    doc.querySelectorAll('div.response-content')[0].innerText = 'late old response update';
    return { ok: true };
  };
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, false);
  assert.notEqual(result.error, 'success');
});

test('unknown status and active loader cannot complete a response', async () => {
  const { ops, doc } = fixture({
    statuses: ['unknown', 'unknown', 'unknown'],
    onClick: fixtureDoc => {
      const turn = fixtureDoc.addTurn('new', 'partial');
      turn.append(new FixtureNode('div', { className: 'loader animate' }));
    },
  });
  const result = await ops.sendAndWait('new prompt', { ...sendOptions, timeout: 60 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  assert.equal(doc.querySelectorAll('div.response-content').length, 1);
});

test('mic state still waits while the selected response loader is active', async () => {
  const { ops } = fixture({
    statuses: ['mic', 'mic', 'mic'],
    onClick: doc => {
      const turn = doc.addTurn('new', 'image is being prepared');
      turn.append(new FixtureNode('div', { className: 'loader animate' }));
    },
  });
  const result = await ops.sendAndWait('new prompt', { ...sendOptions, timeout: 60 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
});

test('sendAndWait refuses to click while a previous generation is still active', async () => {
  const { ops } = fixture();
  let fills = 0;
  let clicks = 0;
  ops.getStatus = async () => ({ status: 'stop' });
  ops.fillPrompt = async () => { fills++; return { ok: true }; };
  ops.click = async () => { clicks++; return { ok: true }; };
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'previous_generation_active');
  assert.equal(fills, 0);
  assert.equal(clicks, 0);
});

test('sendAndWait rechecks for a previous generation before clicking send', async () => {
  const { ops } = fixture();
  const states = ['mic', 'mic', 'stop'];
  let fills = 0;
  let clicks = 0;
  ops.getStatus = async () => ({ status: states.shift() || 'mic' });
  ops.fillPrompt = async () => { fills++; return { ok: true }; };
  ops.click = async () => { clicks++; return { ok: true }; };
  const result = await ops.sendAndWait('new prompt', sendOptions);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'previous_generation_active');
  assert.equal(fills, 1);
  assert.equal(clicks, 0);
});

test('getAnswerState uses the real getStatus method', async () => {
  const { ops } = fixture();
  ops.getStatus = async () => ({ status: 'stop', marker: 'real-status-method' });
  const result = await ops.getAnswerState();
  assert.equal(result.answering, true);
  assert.equal(result.status, 'answering');
  assert.equal(result.detail.marker, 'real-status-method');
});
