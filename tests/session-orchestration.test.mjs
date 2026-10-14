import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createMutex, createSingleFlight, createSessionTaskRunner } from '../src/session-queue.js';
import { runImageGeneration } from '../src/image-generation-flow.js';
import { SessionLeaseManager } from '../src/daemon/session-lease.js';
import config from '../src/config.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browserSource = readFileSync(new URL('../src/browser.js', import.meta.url), 'utf8');

function actualBrowserFunction(declaration) {
  const start = browserSource.indexOf(declaration);
  assert.notEqual(start, -1, `missing source declaration: ${declaration}`);
  const open = browserSource.indexOf('{', start);
  assert.notEqual(open, -1, `missing function body: ${declaration}`);
  let depth = 0;
  for (let index = open; index < browserSource.length; index += 1) {
    if (browserSource[index] === '{') depth += 1;
    if (browserSource[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return browserSource.slice(start, index + 1).replace(/^export\s+/, '');
      }
    }
  }
  throw new Error(`unterminated function body: ${declaration}`);
}

test('default generation creates one chat, selects Argon/high before references, and generates once', async () => {
  const calls = [];
  const ops = {
    async click(name) { calls.push(`click:${name}`); return { ok: true }; },
    async switchToModel(model) { calls.push(`model:${model}`); return { ok: true }; },
    async setThinkingDepth(level) { calls.push(`thinking:${level}`); return { ok: true }; },
    async uploadImage(path) { calls.push(`upload:${path}`); return { ok: true }; },
    async generateImage(prompt) { calls.push(`generate:${prompt}`); return { ok: true, dataUrl: 'data' }; },
  };

  const result = await runImageGeneration(ops, {
    prompt: 'a test image', newSession: true, referenceImages: ['ref.png'], fullSize: false, timeout: 1000,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    'click:newChatBtn', 'model:argon', 'thinking:high', 'upload:ref.png', 'generate:a test image',
  ]);
});

test('explicit model and thinking level override the defaults', async () => {
  const calls = [];
  const result = await runImageGeneration({
    async click() { return { ok: true }; },
    async switchToModel(model) { calls.push(`model:${model}`); return { ok: true }; },
    async setThinkingDepth(level) { calls.push(`thinking:${level}`); return { ok: true }; },
    async uploadImage() { calls.push('upload'); return { ok: true }; },
    async generateImage() { calls.push('generate'); return { ok: true }; },
  }, { prompt: 'x', model: 'latest', thinkingLevel: 'medium', referenceImages: ['ref.png'] });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['model:latest', 'thinking:medium', 'upload', 'generate']);
});

test('new-chat failure stops before model selection, uploads, and generation', async () => {
  const calls = [];
  const result = await runImageGeneration({
    async click() { calls.push('chat'); return { ok: false, error: 'button unavailable' }; },
    async ensureModelPro() { calls.push('model'); return { ok: true }; },
    async uploadImage() { calls.push('upload'); return { ok: true }; },
    async generateImage() { calls.push('generate'); return { ok: true }; },
  }, { prompt: 'x', newSession: true, referenceImages: ['ref.png'] });

  assert.deepEqual(result, { ok: false, stage: 'new_chat', error: 'button unavailable' });
  assert.deepEqual(calls, ['chat']);
});

test('latest model selection failure stops before thinking, references, and generation', async () => {
  const calls = [];
  const result = await runImageGeneration({
    async click() { calls.push('chat'); return { ok: true }; },
    async switchToModel(model) { calls.push(`model:${model}`); return { ok: false, error: 'model menu failed' }; },
    async setThinkingDepth(level) { calls.push(`thinking:${level}`); return { ok: true }; },
    async uploadImage() { calls.push('upload'); return { ok: true }; },
    async generateImage() { calls.push('generate'); return { ok: true }; },
  }, { prompt: 'x', newSession: true, model: 'latest', referenceImages: ['ref.png'] });

  assert.deepEqual(result, { ok: false, stage: 'model', error: 'model menu failed' });
  assert.deepEqual(calls, ['chat', 'model:latest']);
});

test('thinking selection failure stops before reference upload and generation', async () => {
  const calls = [];
  const result = await runImageGeneration({
    async click() { calls.push('chat'); return { ok: true }; },
    async switchToModel(model) { calls.push(`model:${model}`); return { ok: true }; },
    async setThinkingDepth(level) { calls.push(`thinking:${level}`); return { ok: false, error: 'level missing' }; },
    async uploadImage() { calls.push('upload'); return { ok: true }; },
    async generateImage() { calls.push('generate'); return { ok: true }; },
  }, { prompt: 'x', newSession: true, referenceImages: ['ref.png'] });

  assert.deepEqual(result, { ok: false, stage: 'thinking', error: 'level missing' });
  assert.deepEqual(calls, ['chat', 'model:argon', 'thinking:high']);
});

test('MCP page task runner serializes work and awaits exception cleanup', async () => {
  const events = [];
  const runner = createSessionTaskRunner({
    mutex: createMutex(),
    async disconnect() { events.push('disconnect'); await pause(2); },
  });

  const first = runner(async () => {
    events.push('first:start');
    await pause(10);
    events.push('first:throw');
    throw new Error('operation failed');
  });
  const second = runner(async () => {
    events.push('second:start');
    return 'done';
  });

  await assert.rejects(first, /operation failed/);
  assert.equal(await second, 'done');
  assert.deepEqual(events, [
    'first:start', 'first:throw', 'disconnect', 'second:start', 'disconnect',
  ]);
});

test('Daemon lease serializes clients and rejects stale-owner release', async () => {
  const manager = new SessionLeaseManager({ leaseMs: 500 });
  const first = await manager.acquire('client-a');
  let secondResolved = false;
  const secondPromise = manager.acquire('client-b', { waitMs: 300 }).then((lease) => {
    secondResolved = true;
    return lease;
  });

  await pause(10);
  assert.equal(secondResolved, false);
  assert.equal(manager.release('wrong-token'), false);
  assert.equal(manager.getActiveLeaseCount(), 1);

  assert.equal(manager.release(first.token), true);
  const second = await secondPromise;
  assert.equal(second.ownerId, 'client-b');
  assert.notEqual(second.token, first.token);
  assert.equal(manager.release(first.token), false);
  assert.equal(manager.release(second.token), true);
});

test('Daemon lease wait supports timeout and AbortSignal cancellation', async () => {
  const manager = new SessionLeaseManager({ leaseMs: 500 });
  const owner = await manager.acquire('owner');

  await assert.rejects(
    manager.acquire('timeout-client', { waitMs: 10 }),
    (error) => error.code === 'SESSION_LEASE_TIMEOUT',
  );

  const controller = new AbortController();
  const canceled = manager.acquire('cancel-client', { waitMs: 300, signal: controller.signal });
  controller.abort();
  await assert.rejects(canceled, (error) => error.code === 'SESSION_LEASE_CANCELED');
  assert.equal(manager.getState().waiting, 0);
  assert.equal(manager.release(owner.token), true);
});

test('expired lease is fenced and queued owner receives access', async () => {
  const manager = new SessionLeaseManager({ leaseMs: 25, maxWaitMs: 200 });
  const first = await manager.acquire('short-lived-owner');
  const nextPromise = manager.acquire('queued-owner', { waitMs: 150 });
  await pause(35);
  const next = await nextPromise;

  assert.equal(next.ownerId, 'queued-owner');
  assert.equal(manager.release(first.token), false);
  assert.equal(manager.getActiveLeaseCount(), 1);
  assert.equal(manager.release(next.token), true);
});

test('cold-start single-flight shares concurrent initialization and resets afterward', async () => {
  let calls = 0;
  let finish;
  const ensure = createSingleFlight(() => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  });

  const first = ensure();
  const concurrent = ensure();
  await pause(0);
  assert.equal(calls, 1);
  finish('connected');
  assert.equal(await first, 'connected');
  assert.equal(await concurrent, 'connected');

  const later = ensure();
  await pause(0);
  assert.equal(calls, 2);
  finish('reused');
  assert.equal(await later, 'reused');
});

test('actual browser.js disconnect awaits CDP close before releasing the lease', async () => {
  const events = [];
  const context = {
    _browser: {
      async disconnect() {
        events.push('cdp:disconnect:start');
        await pause(25);
        events.push('cdp:disconnect:end');
      },
    },
    _leaseToken: 'lease-A',
    _leaseExpiresAt: Date.now() + 60_000,
    _leaseRenewTimer: null,
    _disconnectPromise: null,
    clearTimeout() {},
    async releaseSessionLease(token) { events.push(`lease:release:${token}`); },
    console: { log() {}, error() {} },
  };
  runInNewContext(`${actualBrowserFunction('export function disconnect()')}; globalThis.invokeDisconnect = disconnect;`, context);

  const disconnecting = context.invokeDisconnect();
  await pause(5);
  assert.deepEqual(events, ['cdp:disconnect:start']);
  await disconnecting;
  assert.deepEqual(events, ['cdp:disconnect:start', 'cdp:disconnect:end', 'lease:release:lease-A']);
});

test('actual browser.js ignores a late renewal response from a previous lease token', async () => {
  const timers = [];
  let resolveRenewal;
  let requestedToken;
  const renewalResponse = new Promise((resolve) => { resolveRenewal = resolve; });
  const context = {
    _leaseToken: 'lease-A',
    _leaseExpiresAt: Date.now() + 60_000,
    _leaseRenewTimer: null,
    clearTimeout() {},
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    requestJSON(_path, options) {
      requestedToken = options.body.token;
      return renewalResponse;
    },
    loseSessionLease(token) { throw new Error(`unexpected lease loss for ${token}`); },
    console: { error() {} },
    Date,
  };
  runInNewContext(`${actualBrowserFunction('function startLeaseRenewal(leaseMs)')}; globalThis.startRenewal = startLeaseRenewal;`, context);
  context.startRenewal(60_000);
  const oldRenewal = timers[0].callback();
  assert.equal(requestedToken, 'lease-A');

  const leaseBExpiresAt = Date.now() + 120_000;
  context._leaseToken = 'lease-B';
  context._leaseExpiresAt = leaseBExpiresAt;
  const leaseBTimer = { owner: 'lease-B' };
  context._leaseRenewTimer = leaseBTimer;
  resolveRenewal({ ok: true, expiresAt: Date.now() + 600_000 });
  await oldRenewal;

  assert.equal(context._leaseToken, 'lease-B');
  assert.equal(context._leaseExpiresAt, leaseBExpiresAt);
  assert.equal(context._leaseRenewTimer, leaseBTimer);
  assert.equal(timers.length, 1, 'stale response must not schedule a duplicate renewal timer');
});

test('actual browser.js cold browser acquire uses configured finite startup budget', async () => {
  const calls = [];
  const context = {
    config: { browserAcquireTimeoutMs: config.browserAcquireTimeoutMs },
    async requestJSON(...args) {
      calls.push(args);
      return { ok: true, wsEndpoint: 'ws://fake' };
    },
  };
  runInNewContext(`${actualBrowserFunction('async function acquireBrowserEndpoint()')}; globalThis.acquire = acquireBrowserEndpoint;`, context);

  const result = await context.acquire();

  assert.equal(result.wsEndpoint, 'ws://fake');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/browser/acquire');
  assert.equal(calls[0][1].timeoutMs, config.browserAcquireTimeoutMs);
  assert.ok(Number.isFinite(config.browserAcquireTimeoutMs));
  assert.ok(config.browserAcquireTimeoutMs >= 90_000);
  assert.ok(config.browserAcquireTimeoutMs >= config.browserProtocolTimeout + 30_000);
});
