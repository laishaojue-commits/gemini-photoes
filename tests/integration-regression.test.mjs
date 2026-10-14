import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDownloadLifecycle, createDownloadWorkspace, normalizeResourceIdentity } from '../src/gemini-download.js';
import { removeOwnedTempCase } from './helpers/temp-case.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helpersDir = join(repoRoot, 'tests', 'helpers');
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));

function readJsonLines(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function argsForGeminiTool(name) {
  switch (name) {
    case 'gemini_generate_image': return { prompt: 'fixture prompt', newSession: false, referenceImages: [], fullSize: true, timeout: 1000 };
    case 'gemini_switch_model': return { model: 'latest' };
    case 'gemini_set_thinking_depth': return { level: 'standard' };
    case 'gemini_send_message': return { message: 'fixture message', timeout: 1000 };
    case 'gemini_upload_images': return { images: ['fixture.png'] };
    case 'gemini_extract_image': return { imageUrl: 'https://lh3.googleusercontent.com/fixture=s512' };
    case 'gemini_share_latest_image': return { index: 0, timeout: 1000, copyToClipboard: false, closeDialog: false };
    case 'gemini_reload_page': return { timeout: 1000 };
    case 'gemini_navigate_to': return { url: 'https://gemini.google.com/app', timeout: 1000 };
    default: return {};
  }
}

async function startMcpFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gemini-mcp-regression-'));
  const outputDir = join(directory, 'output');
  const logPath = join(directory, 'events.jsonl');
  const controlPath = join(directory, 'control.json');
  writeFileSync(logPath, '');
  writeFileSync(controlPath, '{}');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(join(helpersDir, 'mcp-import-hook.mjs')).href, 'src/mcp-server.js'],
    cwd: repoRoot,
    stderr: 'pipe',
    env: {
      MCP_TEST_LOG: logPath,
      MCP_TEST_CONTROL: controlPath,
      MCP_TEST_OUTPUT_DIR: outputDir,
      MCP_TEST_OP_DELAY_MS: '3',
      MCP_TEST_DAEMON_PORT: '1',
    },
  });
  let serverStderr = '';
  transport.stderr?.setEncoding('utf8').on('data', chunk => { serverStderr += chunk; });
  const client = new Client({ name: 'gemini-regression', version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (error) {
    const pid = transport.pid;
    await Promise.race([client.close().catch(() => {}), pause(300)]);
    await Promise.race([transport.close().catch(() => {}), pause(300)]);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    removeOwnedTempCase(directory, 'gemini-mcp-regression-');
    throw new Error(`MCP fixture failed to initialize: ${error.message}\n${serverStderr}`);
  }
  return { directory, outputDir, logPath, controlPath, client, transport, get pid() { return transport.pid; } };
}

test('real MCP stdio initialization exposes 21 tools and all stateful Gemini callbacks share one queue', async t => {
  const fixture = await startMcpFixture();
  t.after(async () => {
    const pid = fixture.pid;
    await Promise.race([fixture.client.close().catch(() => {}), pause(300)]);
    await Promise.race([fixture.transport.close().catch(() => {}), pause(300)]);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    removeOwnedTempCase(fixture.directory, 'gemini-mcp-regression-');
  });

  const { tools } = await fixture.client.listTools();
  assert.equal(tools.length, 21);
  const geminiNames = tools.map(tool => tool.name).filter(name => name.startsWith('gemini_')).sort();
  assert.equal(geminiNames.length, 18);
  assert.ok(geminiNames.includes('gemini_browser_info'));

  const toolByName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  const generationSchema = toolByName.gemini_generate_image.inputSchema;
  const schemaProperties = generationSchema.properties;
  assert.equal(schemaProperties.model.default, 'argon', 'MCP schema must expose Argon as the default rather than silently defaulting to Pro');
  assert.ok(schemaProperties.model.enum.includes('latest'), 'latest must be accepted as a dynamic model-menu alias');
  assert.equal(schemaProperties.thinkingLevel.default, 'high');
  assert.deepEqual(schemaProperties.thinkingLevel.enum, ['low', 'medium', 'high', 'standard', 'extended']);
  assert.match(schemaProperties.thinkingLevel.description, /standard.*medium.*extended.*high/);
  const thinkingSchema = toolByName.gemini_set_thinking_depth.inputSchema.properties.level;
  assert.ok(thinkingSchema.enum.includes('standard') && thinkingSchema.enum.includes('extended'));
  assert.match(thinkingSchema.description, /standard.*medium.*extended.*high/);

  const statefulNames = geminiNames.filter(name => name !== 'gemini_browser_info');
  assert.equal(statefulNames.length, 17);
  const results = await Promise.all(statefulNames.map(name => fixture.client.callTool({
    name,
    arguments: argsForGeminiTool(name),
  })));
  assert.equal(results.length, 17);
  assert.ok(results.every(result => !result.isError), 'all stateful Gemini callbacks should finish through the fixture boundary');

  const events = readJsonLines(fixture.logPath);
  const opEvents = events.filter(event => event.event === 'op:start' || event.event === 'op:end');
  let active = 0;
  let maximumActive = 0;
  for (const event of opEvents) {
    active += event.event === 'op:start' ? 1 : -1;
    maximumActive = Math.max(maximumActive, active);
  }
  assert.equal(active, 0);
  assert.equal(maximumActive, 1, 'the actual MCP callback dispatches must serialize page operations');
  assert.ok(events.some(event => event.event === 'op:start' && event.method === 'switchToModel' && event.args?.[0] === 'argon'));
  assert.ok(events.some(event => event.event === 'op:start' && event.method === 'setThinkingDepth' && event.args?.[0] === 'high'));
  assert.ok(events.some(event => event.event === 'op:start' && event.method === 'switchToModel' && event.args?.[0] === 'latest'), 'MCP latest must reach the dynamic model selector unchanged');
  assert.ok(events.some(event => event.event === 'op:start' && event.method === 'setThinkingDepth' && event.args?.[0] === 'standard'), 'legacy thinking aliases must reach the compatibility layer');

  // Explicit Pro/low overrides must make it through the real MCP callback and
  // generation flow rather than a fixture-only direct function call.
  writeFileSync(fixture.logPath, '');
  const override = await fixture.client.callTool({
    name: 'gemini_generate_image',
    arguments: { prompt: 'explicit override', model: 'pro', thinkingLevel: 'low', fullSize: true, timeout: 1000 },
  });
  assert.equal(override.isError, undefined);
  const overrideEvents = readJsonLines(fixture.logPath);
  assert.ok(overrideEvents.some(event => event.event === 'op:start' && event.method === 'switchToModel' && event.args?.[0] === 'pro'));
  assert.ok(overrideEvents.some(event => event.event === 'op:start' && event.method === 'setThinkingDepth' && event.args?.[0] === 'low'));
  assert.ok(overrideEvents.some(event => event.event === 'op:start' && event.method === 'generateImage'));

  // The image tool itself must also forward latest to the dynamic menu and
  // preserve the documented medium level through its MCP schema/callback.
  writeFileSync(fixture.logPath, '');
  const latestGeneration = await fixture.client.callTool({
    name: 'gemini_generate_image',
    arguments: { prompt: 'dynamic model selection', model: 'latest', thinkingLevel: 'medium', fullSize: true, timeout: 1000 },
  });
  assert.equal(latestGeneration.isError, undefined);
  const latestEvents = readJsonLines(fixture.logPath);
  assert.ok(latestEvents.some(event => event.event === 'op:start' && event.method === 'switchToModel' && event.args?.[0] === 'latest'));
  assert.ok(latestEvents.some(event => event.event === 'op:start' && event.method === 'setThinkingDepth' && event.args?.[0] === 'medium'));

  // A real operation-level thinking failure must be surfaced and must stop
  // before reference upload or image generation.
  writeFileSync(fixture.logPath, '');
  writeFileSync(fixture.controlPath, JSON.stringify({ failMethod: 'setThinkingDepth', failError: 'thinking option unavailable' }));
  const thinkingFailure = await fixture.client.callTool({
    name: 'gemini_generate_image',
    arguments: { prompt: 'must stop', model: 'argon', thinkingLevel: 'high', referenceImages: ['unused-reference.png'], timeout: 1000 },
  });
  writeFileSync(fixture.controlPath, '{}');
  assert.equal(thinkingFailure.isError, true);
  assert.match(thinkingFailure.content[0].text, /设置 high 思考等级失败: thinking option unavailable/);
  const thinkingEvents = readJsonLines(fixture.logPath);
  assert.ok(thinkingEvents.some(event => event.event === 'op:fail' && event.method === 'setThinkingDepth'));
  assert.ok(!thinkingEvents.some(event => event.event === 'op:start' && ['uploadImage', 'generateImage'].includes(event.method)));

  // The production generation callback must use the shared preflight/upload flow:
  // one requested new chat, then reference upload, with no late second chat.
  writeFileSync(fixture.logPath, '');
  const generated = await fixture.client.callTool({
    name: 'gemini_generate_image',
    arguments: { prompt: 'with reference', newSession: true, referenceImages: ['reference.png'], fullSize: true, timeout: 1000 },
  });
  assert.equal(generated.isError, undefined);
  const generationEvents = readJsonLines(fixture.logPath);
  const generationOps = generationEvents.filter(event => event.event === 'op:start').map(event => event.method);
  assert.equal(generationOps.filter(method => method === 'click').length, 1);
  assert.ok(generationOps.indexOf('uploadImage') > generationOps.indexOf('click'));
  assert.ok(generationOps.indexOf('generateImage') > generationOps.indexOf('uploadImage'));

  // Force a failure at the operation boundary and verify wrapper finally cleanup
  // completes before the MCP call returns.
  writeFileSync(fixture.logPath, '');
  writeFileSync(fixture.controlPath, JSON.stringify({ throwMethod: 'click' }));
  const failed = await fixture.client.callTool({ name: 'gemini_new_chat', arguments: {} });
  writeFileSync(fixture.controlPath, '{}');
  assert.equal(failed.isError, true);
  const failureEvents = readJsonLines(fixture.logPath).map(event => event.event);
  assert.ok(failureEvents.indexOf('op:throw') >= 0);
  assert.ok(failureEvents.indexOf('disconnect:end') > failureEvents.indexOf('op:throw'));
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeTimers(initialTime = 10_000) {
  let now = initialTime;
  let nextId = 1;
  const timers = new Map();
  const setTimeoutFake = (callback, delay = 0) => {
    const timer = { id: nextId++, due: now + Math.max(0, Number(delay) || 0), callback, unref() {} };
    timers.set(timer.id, timer);
    return timer;
  };
  const clearTimeoutFake = timer => timers.delete(typeof timer === 'object' ? timer?.id : timer);
  return {
    get now() { return now; },
    timers,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    async fireNext() {
      const timer = [...timers.values()].sort((a, b) => a.due - b.due)[0];
      assert.ok(timer, 'expected a scheduled browser lease timer');
      timers.delete(timer.id);
      now = timer.due;
      const result = timer.callback();
      if (result && typeof result.then === 'function') await result;
      await Promise.resolve();
      return timer;
    },
    nextDelay() {
      const timer = [...timers.values()].sort((a, b) => a.due - b.due)[0];
      return timer ? timer.due - now : null;
    },
  };
}

async function loadBrowserWithStubs({ renew, firstDisconnectGate } = {}) {
  const vm = await import('node:vm');
  const timer = fakeTimers();
  const events = [];
  let browserCount = 0;
  let acquireCount = 0;
  let connectCount = 0;
  const page = {
    url: () => 'https://gemini.google.com/app/session-fixture',
    async bringToFront() { events.push('page:front'); },
  };
  const browser = () => {
    const ordinal = ++browserCount;
    return {
      isConnected: () => true,
      async pages() { return [page]; },
      async disconnect() {
        events.push(`disconnect:${ordinal}:start`);
        if (ordinal === 1 && firstDisconnectGate) await firstDisconnectGate.promise;
        events.push(`disconnect:${ordinal}:end`);
      },
    };
  };
  const fakePuppeteer = {
    use() {},
    async connect() {
      connectCount++;
      events.push(`connect:${connectCount}`);
      return browser();
    },
  };
  let uuid = 0;
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.pathname === '/health') return response(200, { ok: true });
    if (url.pathname === '/session/acquire') {
      acquireCount++;
      const token = `token-${acquireCount === 1 ? 'A' : 'B'}`;
      events.push(`acquire:${token}`);
      return response(200, { ok: true, token, ownerId: token, expiresAt: timer.now + 30_000, leaseMs: 12_000 });
    }
    if (url.pathname === '/browser/acquire') return response(200, { ok: true, wsEndpoint: 'ws://fixture', pid: 42 });
    if (url.pathname === '/session/renew') {
      events.push(`renew:${body.token}:start`);
      const result = await renew?.(body.token, timer.now) || response(200, { ok: true, expiresAt: timer.now + 30_000 });
      events.push(`renew:${body.token}:end`);
      return result;
    }
    if (url.pathname === '/session/release') {
      events.push(`release:${body.token}`);
      return response(200, { ok: true, released: true });
    }
    throw new Error(`unexpected fixture fetch path: ${url.pathname}`);
  };
  const realDate = Date;
  class FakeDate extends realDate { static now() { return timer.now; } }
  const context = vm.createContext({
    console: { log() {}, warn() {}, info() {}, debug() {}, error() {} },
    process: { execPath: 'node', env: {} },
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    Date: FakeDate,
    fetch,
    AbortSignal,
  });
  const synthetic = new Map();
  const syntheticModule = (specifier, exports) => {
    const cached = synthetic.get(specifier);
    if (cached) return cached;
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context, identifier: specifier });
    synthetic.set(specifier, module);
    return module;
  };
  const stubPuppeteerCore = syntheticModule('puppeteer-core', { default: {} });
  const stubPuppeteerExtra = syntheticModule('puppeteer-extra', { addExtra: () => fakePuppeteer });
  const stubStealth = syntheticModule('puppeteer-extra-plugin-stealth', { default: () => ({}) });
  const stubConfig = syntheticModule('./config.js', { default: {
    daemonPort: 40225,
    sessionLeaseWaitMs: 1000,
    sessionLeaseMs: 12_000,
    browserProtocolTimeout: 1000,
  } });
  const stubUtil = syntheticModule('./util.js', { sleep: async () => {} });
  const stubQueue = syntheticModule('./session-queue.js', {
    createSingleFlight(task) {
      let pending = null;
      return (...args) => {
        if (!pending) pending = Promise.resolve().then(() => task(...args)).finally(() => { pending = null; });
        return pending;
      };
    },
  });
  const stubs = new Map([
    ['node:child_process', syntheticModule('node:child_process', { spawn: () => { throw new Error('spawn must not be used'); } })],
    ['node:crypto', syntheticModule('node:crypto', { randomUUID: () => `owner-${++uuid}` })],
    ['node:url', syntheticModule('node:url', { fileURLToPath: value => new URL(value).pathname })],
    ['node:path', syntheticModule('node:path', {
      dirname: value => value.slice(0, value.lastIndexOf('/')),
      join: (...parts) => parts.join('/'),
    })],
    ['puppeteer-core', stubPuppeteerCore],
    ['puppeteer-extra', stubPuppeteerExtra],
    ['puppeteer-extra-plugin-stealth', stubStealth],
    ['./config.js', stubConfig],
    ['./util.js', stubUtil],
    ['./session-queue.js', stubQueue],
  ]);
  const source = readFileSync(join(repoRoot, 'src', 'browser.js'), 'utf8');
  const root = new vm.SourceTextModule(source, {
    context,
    identifier: 'file:///fixture/src/browser.js',
    initializeImportMeta(meta) { meta.url = 'file:///fixture/src/browser.js'; },
  });
  await root.link(specifier => {
    const module = stubs.get(specifier);
    if (!module) throw new Error(`unmocked browser import: ${specifier}`);
    return module;
  });
  await root.evaluate();
  return {
    exports: root.namespace,
    timer,
    events,
    get acquireCount() { return acquireCount; },
    get connectCount() { return connectCount; },
  };
}

test('browser lease 409 is fail-closed and waits for old CDP disconnect before reconnect', async () => {
  const gate = createDeferred();
  const fixture = await loadBrowserWithStubs({
    firstDisconnectGate: gate,
    renew: async () => response(409, { ok: false, error: 'lease_expired_or_unknown' }),
  });
  await fixture.exports.ensureBrowser();
  assert.equal(fixture.acquireCount, 1);

  await fixture.timer.fireNext();
  for (let i = 0; i < 20 && !fixture.events.includes('disconnect:1:start'); i++) await pause(1);
  assert.ok(fixture.events.includes('disconnect:1:start'));

  const reconnect = fixture.exports.ensureBrowser();
  await pause(10);
  assert.equal(fixture.acquireCount, 1, 'no new lease may be acquired while the old CDP socket is still closing');
  assert.equal(fixture.connectCount, 1, 'no new CDP client may connect while disconnectPending is unresolved');

  gate.resolve();
  await reconnect;
  assert.ok(fixture.events.indexOf('disconnect:1:end') < fixture.events.indexOf('acquire:token-B'));
  assert.equal(fixture.connectCount, 2);
  await fixture.exports.disconnect();
});

test('an in-flight token A renewal cannot mutate lease B or schedule another A timer', async () => {
  const renewal = createDeferred();
  const fixture = await loadBrowserWithStubs({ renew: async token => token === 'token-A' ? renewal.promise : response(200, { ok: true, expiresAt: fixture.timer.now + 30_000 }) });
  await fixture.exports.ensureBrowser();

  const renewTask = fixture.timer.fireNext();
  await pause(0);
  assert.ok(fixture.events.includes('renew:token-A:start'));
  await fixture.exports.disconnect();
  await fixture.exports.ensureBrowser();
  assert.equal(fixture.acquireCount, 2);
  assert.equal(fixture.timer.nextDelay(), 3_000, 'lease B should retain its own renewal timer');

  renewal.resolve(response(200, { ok: true, expiresAt: fixture.timer.now + 5_500 }));
  await renewTask;
  assert.equal(fixture.timer.nextDelay(), 3_000, 'late token A result must not replace B expiry or schedule a short stale timer');
  await fixture.exports.disconnect();
});

async function daemonChild(t) {
  const reservation = createServer();
  await new Promise((resolveListen, reject) => reservation.listen(0, '127.0.0.1', resolveListen).once('error', reject));
  const port = reservation.address().port;
  await new Promise(resolveClose => reservation.close(resolveClose));

  const child = spawn(process.execPath, ['--import', pathToFileURL(join(helpersDir, 'daemon-test-hook.mjs')).href, 'src/daemon/server.js'], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DAEMON_TEST_PORT: String(port),
      DAEMON_TEST_TTL_MS: '40',
      DAEMON_TEST_LEASE_MS: '220',
      DAEMON_TEST_WAIT_MS: '1200',
    },
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), pause(1500)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  t.after(stop);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`fixture daemon exited early: ${output}`);
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(300) });
      if (health.ok) return { child, baseUrl, port, get output() { return output; }, stop };
    } catch {}
    await pause(20);
  }
  throw new Error(`fixture daemon did not start: ${output}`);
}

async function postJSON(baseUrl, path, body, { signal } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  return { status: res.status, body: await res.json() };
}

test('real localhost Daemon HTTP routes enforce FIFO leases, cancellation, TTL hold, and loopback bind', async t => {
  const daemon = await daemonChild(t);
  assert.match(daemon.baseUrl, /^http:\/\/127\.0\.0\.1:/);
  await assert.rejects(fetch(`http://[::1]:${daemon.port}/health`, { signal: AbortSignal.timeout(500) }));

  const owner = await postJSON(daemon.baseUrl, '/session/acquire', { ownerId: 'owner-A', waitMs: 1000 });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.ownerId, 'owner-A');

  const waiterB = postJSON(daemon.baseUrl, '/session/acquire', { ownerId: 'owner-B', waitMs: 1000 });
  await pause(25);
  const waiterC = postJSON(daemon.baseUrl, '/session/acquire', { ownerId: 'owner-C', waitMs: 1000 });
  await pause(25);

  const rejectedRelease = await postJSON(daemon.baseUrl, '/session/release', { token: 'not-a-token' });
  assert.equal(rejectedRelease.body.released, false);
  const renewed = await postJSON(daemon.baseUrl, '/session/renew', { token: owner.body.token });
  assert.equal(renewed.status, 200);
  assert.ok(renewed.body.expiresAt > owner.body.expiresAt);

  assert.equal((await postJSON(daemon.baseUrl, '/session/release', { token: owner.body.token })).body.released, true);
  const leaseB = await waiterB;
  assert.equal(leaseB.body.ownerId, 'owner-B');
  assert.equal((await postJSON(daemon.baseUrl, '/session/release', { token: owner.body.token })).body.released, false);
  const staleRelease = await postJSON(daemon.baseUrl, '/session/release', { token: owner.body.token });
  assert.equal(staleRelease.body.released, false, 'an expired token cannot release a newer owner');
  assert.equal((await postJSON(daemon.baseUrl, '/session/release', { token: leaseB.body.token })).body.released, true);
  const leaseC = await waiterC;
  assert.equal(leaseC.body.ownerId, 'owner-C');
  assert.equal((await postJSON(daemon.baseUrl, '/session/release', { token: leaseC.body.token })).body.released, true);

  const disconnectOwner = await postJSON(daemon.baseUrl, '/session/acquire', { ownerId: 'disconnect-owner', waitMs: 1000 });
  const abortController = new AbortController();
  const abandonedWait = postJSON(daemon.baseUrl, '/session/acquire', { ownerId: 'abandoned-waiter', waitMs: 1000 }, { signal: abortController.signal }).catch(error => error);
  await pause(30);
  abortController.abort();
  await abandonedWait;
  const survivingWait = postJSON(daemon.baseUrl, '/session/acquire', { ownerId: 'surviving-waiter', waitMs: 1000 });
  await pause(20);
  assert.equal((await postJSON(daemon.baseUrl, '/session/release', { token: disconnectOwner.body.token })).body.released, true);
  const survivorLease = await survivingWait;
  assert.equal(survivorLease.body.ownerId, 'surviving-waiter', 'aborted HTTP waiter must be removed before the next FIFO grant');
  await postJSON(daemon.baseUrl, '/session/release', { token: survivorLease.body.token });

  const ttlLease = await postJSON(daemon.baseUrl, '/session/acquire', { ownerId: 'ttl-holder', waitMs: 1000 });
  await pause(75);
  const healthWhileHeld = await fetch(`${daemon.baseUrl}/health`);
  assert.equal(healthWhileHeld.status, 200, 'active lease must keep the daemon alive beyond its short idle TTL');
  assert.match(daemon.output, /session lease still active; extending browser lifetime/);
  await postJSON(daemon.baseUrl, '/session/release', { token: ttlLease.body.token });
});

test('real createOps generation handoff sends the bound new response src to the download stage', async () => {
  const { createOps } = await import('../src/gemini-ops.js');
  const page = { evaluate: async (fn, ...args) => fn(...args), isClosed: () => false };
  const ops = createOps(page);
  const boundResponse = {
    ok: true,
    elapsed: 2,
    responseIndex: 1,
    responseIdentity: 'new-turn-identity',
    responsePageKey: 'gemini-page-key',
    responseImageBaseline: ['old-image-src'],
  };
  let imageRequest;
  ops.sendAndWait = async () => boundResponse;
  ops.getResponseImages = async options => {
    assert.deepEqual(options, {
      index: 1,
      identity: 'new-turn-identity',
      pageKey: 'gemini-page-key',
    });
    return {
      ok: true,
      loader: false,
      images: [
        { src: 'old-image-src', index: 0, loaded: true, width: 512 },
        { src: 'new-response-image-src', index: 1, loaded: true, width: 768 },
      ],
    };
  };
  ops.downloadFullSizeImage = async args => {
    imageRequest = args;
    return { ok: true, filePath: 'fixture-output.png', index: args.index, total: 2 };
  };

  const result = await ops.generateImage('draw the latest turn', { fullSize: true, timeout: 1000 });
  assert.equal(result.ok, true);
  assert.equal(imageRequest.imageUrl, 'new-response-image-src');
  assert.equal(imageRequest.index, 1);
  assert.ok(imageRequest.timeout > 0);
});

test('download lifecycle cleanup, frame/resource scope, unique final names, and dimension URL identity', async t => {
  const emitter = new EventEmitter();
  const lifecycle = createDownloadLifecycle(emitter, {
    frameId: 'main-frame',
    imageUrl: 'https://lh3.googleusercontent.com/fixture=s512',
    resourceUrls: ['https://lh3.googleusercontent.com/fixture=s1024'],
    timeout: 1000,
  });
  assert.equal(normalizeResourceIdentity('https://lh3.googleusercontent.com/fixture=s512'), normalizeResourceIdentity('https://lh3.googleusercontent.com/fixture=s4096'));
  assert.equal(emitter.listenerCount('Browser.downloadWillBegin'), 1);
  assert.equal(emitter.listenerCount('Browser.downloadProgress'), 1);

  lifecycle.arm();
  emitter.emit('Browser.downloadWillBegin', { frameId: 'other-frame', url: 'https://lh3.googleusercontent.com/fixture=s1024', guid: 'wrong-frame' });
  emitter.emit('Browser.downloadWillBegin', { frameId: 'main-frame', url: 'https://lh3.googleusercontent.com/elsewhere=s1024', guid: 'wrong-resource' });
  assert.equal(lifecycle.hasStarted, false);
  emitter.emit('Browser.downloadWillBegin', { frameId: 'main-frame', url: 'https://lh3.googleusercontent.com/fixture=s1024', guid: 'accepted-guid', suggestedFilename: 'original.png' });
  emitter.emit('Browser.downloadProgress', { guid: 'other-guid', state: 'completed', filePath: 'wrong.png' });
  emitter.emit('Browser.downloadProgress', { guid: 'accepted-guid', state: 'completed', filePath: 'download.png' });
  const completed = await lifecycle.promise;
  assert.equal(completed.ok, true);
  assert.equal(completed.guid, 'accepted-guid');
  assert.equal(completed.filePath, 'download.png');
  lifecycle.cleanup();
  assert.equal(emitter.listenerCount('Browser.downloadWillBegin'), 0);
  assert.equal(emitter.listenerCount('Browser.downloadProgress'), 0);

  const canceled = createDownloadLifecycle(emitter, { frameId: 'main-frame', imageUrl: 'blob:fixture', timeout: 1000 });
  canceled.cancel('fixture_cancel');
  assert.equal((await canceled.promise).error, 'fixture_cancel');
  canceled.cleanup();
  assert.equal(emitter.listenerCount('Browser.downloadWillBegin'), 0);
  assert.equal(emitter.listenerCount('Browser.downloadProgress'), 0);

  const pageFrames = createDownloadLifecycle(emitter, {
    frameId: 'main-frame',
    frameIds: new Set(['main-frame', 'static-child']),
    imageUrl: 'https://lh3.googleusercontent.com/fixture=s512',
    resourceUrls: ['https://lh3.googleusercontent.com/fixture=s1024'],
    timeout: 1000,
  });
  pageFrames.arm();
  assert.equal(pageFrames.addFrame('dynamic-child', 'main-frame'), true);
  assert.equal(pageFrames.addFrame('dynamic-grandchild', 'dynamic-child'), true);
  assert.equal(pageFrames.addFrame('foreign-child', 'foreign-parent'), false);
  emitter.emit('Browser.downloadWillBegin', { frameId: 'foreign-child', url: 'https://lh3.googleusercontent.com/fixture=s1024', guid: 'foreign-guid' });
  assert.equal(pageFrames.hasStarted, false, 'a same-resource event from a foreign page/frame must remain outside the owned frame set');
  emitter.emit('Browser.downloadWillBegin', { frameId: 'dynamic-grandchild', url: 'https://lh3.googleusercontent.com/fixture=s1024', guid: 'owned-grandchild-guid' });
  emitter.emit('Browser.downloadProgress', { guid: 'owned-grandchild-guid', state: 'completed', filePath: 'owned-child.png' });
  const childCompleted = await pageFrames.promise;
  assert.equal(childCompleted.ok, true, 'a download from a dynamically attached descendant of the target Page is valid');
  assert.equal(childCompleted.guid, 'owned-grandchild-guid');
  pageFrames.cleanup();
  assert.equal(emitter.listenerCount('Browser.downloadWillBegin'), 0);
  assert.equal(emitter.listenerCount('Browser.downloadProgress'), 0);

  const directory = mkdtempSync(join(tmpdir(), 'gemini-download-workspace-'));
  t.after(() => removeOwnedTempCase(directory, 'gemini-download-workspace-'));
  const first = createDownloadWorkspace(directory);
  const firstSource = join(first.directory, 'source.part');
  writeFileSync(firstSource, 'first-image');
  const firstResult = first.finalize({ suggestedFilename: '../../sample.PNG', filePath: firstSource });
  assert.equal(firstResult.ok, true);
  assert.equal(dirname(firstResult.filePath), directory);
  assert.equal(readFileSync(firstResult.filePath, 'utf8'), 'first-image');

  const second = createDownloadWorkspace(directory);
  const secondSource = join(second.directory, 'source.part');
  writeFileSync(secondSource, 'second-image');
  const secondResult = second.finalize({ suggestedFilename: 'sample.PNG', filePath: secondSource });
  assert.equal(secondResult.ok, true);
  assert.notEqual(secondResult.filePath, firstResult.filePath);
  assert.equal(secondResult.suggestedFilename.endsWith('.png'), true);
  assert.deepEqual(second.finalize({ suggestedFilename: 'again.png', filePath: secondSource }), {
    ok: false,
    error: 'download_workspace_already_finalized',
  });
});
