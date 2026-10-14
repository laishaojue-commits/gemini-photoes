import assert from 'node:assert/strict';
import test from 'node:test';
import { createOps } from '../src/gemini-ops.js';

class FixtureElement {
  constructor({ tagName = 'DIV', text = '', attrs = {}, visible = true } = {}) {
    this.tagName = tagName.toUpperCase();
    this.innerText = text;
    this.textContent = text;
    this.attrs = attrs;
    this.value = attrs.value || '';
    this.visible = visible;
  }

  getBoundingClientRect() {
    return this.visible ? { x: 0, y: 0, width: 120, height: 24 } : { x: 0, y: 0, width: 0, height: 0 };
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
}

class FixtureDocument {
  constructor({ url, title = 'Fixture page', bodyText = '', bar, editor, loginButton } = {}) {
    this.title = title;
    this.body = { innerText: bodyText };
    this.location = { href: url };
    this.bar = bar || null;
    this.editor = editor || null;
    this.loginButton = loginButton || null;
  }

  querySelector(selector) {
    if (selector === 'div.boqOnegoogleliteOgbOneGoogleBar') return this.bar;
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    if (selector === 'a,button,[role="button"],input[type="submit"]') {
      return this.loginButton ? [this.loginButton] : [];
    }
    if (selector.startsWith('div.ql-editor[')
      || selector === '[contenteditable="true"][aria-label*="Gemini"]'
      || selector === '[contenteditable="true"][data-placeholder*="Gemini"]'
      || selector === 'div[contenteditable="true"][role="textbox"]') {
      return this.editor ? [this.editor] : [];
    }
    return [];
  }
}

function makeOps({
  url = 'https://gemini.google.com/app',
  title,
  bodyText,
  bar = new FixtureElement({ text: '' }),
  editor,
  loginButton,
} = {}) {
  const original = {
    document: globalThis.document,
    location: globalThis.location,
    getComputedStyle: globalThis.getComputedStyle,
  };
  const document = new FixtureDocument({ url, title, bodyText, bar, editor, loginButton });
  globalThis.document = document;
  globalThis.location = { href: url };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });

  const page = { evaluate: (fn, ...args) => fn(...args) };
  return {
    ops: createOps(page),
    restore() {
      globalThis.document = original.document;
      globalThis.location = original.location;
      globalThis.getComputedStyle = original.getComputedStyle;
    },
  };
}

test('empty Google bar without a visible editor is not proof of login', async () => {
  const fixture = makeOps({ bar: new FixtureElement({ text: '' }) });
  try {
    const result = await fixture.ops.checkLogin();
    assert.equal(result.ok, false);
    assert.equal(result.loggedIn, false);
    assert.equal(result.state, 'page_not_ready');
    assert.equal(result.error, 'page_not_ready');
    assert.equal(result.barText, '');
  } finally {
    fixture.restore();
  }
});

test('explicit visible sign-in prompt is reported as login required', async () => {
  const fixture = makeOps({
    bar: null,
    bodyText: 'Choose an account',
    loginButton: new FixtureElement({ tagName: 'BUTTON', text: 'Sign in' }),
  });
  try {
    const result = await fixture.ops.checkLogin();
    assert.equal(result.ok, true);
    assert.equal(result.loggedIn, false);
    assert.equal(result.state, 'login_required');
    assert.equal(result.error, 'login_required');
  } finally {
    fixture.restore();
  }
});

test('visible Gemini editor is positive ready evidence even when the Google bar is empty', async () => {
  const fixture = makeOps({
    bar: new FixtureElement({ text: '' }),
    editor: new FixtureElement({ attrs: { contenteditable: 'true', role: 'textbox' } }),
  });
  try {
    const result = await fixture.ops.checkLogin();
    assert.equal(result.ok, true);
    assert.equal(result.loggedIn, true);
    assert.equal(result.state, 'ready');
    assert.equal(result.barText, '');
  } finally {
    fixture.restore();
  }
});

test('accounts.google.com error page is diagnosed without exposing URL query parameters', async () => {
  const fixture = makeOps({
    url: 'https://accounts.google.com/v3/signin/unknownerror?TL=secret&dsh=private',
    title: 'Google Accounts',
    bodyText: 'Something went wrong. Try again.',
    bar: null,
  });
  try {
    const login = await fixture.ops.checkLogin();
    assert.equal(login.ok, true);
    assert.equal(login.loggedIn, false);
    assert.equal(login.state, 'auth_error');
    assert.equal(login.error, 'authentication_error');

    const probe = await fixture.ops.probe();
    assert.equal(probe.page.url, 'https://accounts.google.com/v3/signin/unknownerror');
    assert.equal(probe.page.state, 'auth_error');
    assert.equal(probe.page.title, 'Google Accounts');
    assert.equal(probe.page.visibleText, 'Something went wrong. Try again.');
    assert.ok(probe.page.visibleText.length <= 600);
    assert.deepEqual(probe.evidence, { loginButtonVisible: false, editorVisible: false });
    assert.equal(JSON.stringify(probe).includes('secret'), false);
    assert.equal(JSON.stringify(probe).includes('private'), false);
  } finally {
    fixture.restore();
  }
});
