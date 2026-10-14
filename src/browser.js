/**
 * browser.js — 浏览器客户端连接器（面向 Skill）
 *
 * 职责：
 *   1. 向 Daemon 服务请求 wsEndpoint，并通过 puppeteer.connect() 直连浏览器。
 *   2. 如果 Daemon 未启动，自动以后台进程拉起 server.js，等待就绪后再连接。
 *
 * 与 Daemon 的关系：
 *   browser.js (Skill 侧)           Daemon (独立进程)
 *   ─────────────────────           ──────────────────
 *   isDaemonAlive()        ──▶     GET /health
 *   spawnDaemon()          ──▶     node src/daemon/server.js (detached)
 *   fetch /browser/acquire ──▶     engine.js: launch/connect
 *   puppeteer.connect(ws)  ──▶     Chrome CDP wsEndpoint
 *   disconnect()           ──▶     浏览器继续由 Daemon 守护
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import config from './config.js';
import { sleep } from './util.js';
import { createSingleFlight } from './session-queue.js';

// connect 也套上 Stealth，双保险
const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ── 路径常量 ──
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAEMON_SCRIPT = join(__dirname, 'daemon', 'server.js');

// ── 模块级单例 ──
let _browser = null;
let _leaseToken = null;
let _leaseExpiresAt = null;
let _leaseRenewTimer = null;
let _disconnectPromise = null;
const _ownerId = randomUUID();

const DAEMON_URL = `http://127.0.0.1:${config.daemonPort}`;

// ── Daemon 自启动配置 ──
/** 拉起 Daemon 后，等待就绪的最长时间（ms） */
const DAEMON_READY_TIMEOUT = 15_000;
/** 轮询间隔（ms） */
const DAEMON_POLL_INTERVAL = 500;
const SESSION_LEASE_WAIT_MS = config.sessionLeaseWaitMs;
const SESSION_LEASE_MS = config.sessionLeaseMs;

/**
 * 检查 Daemon 是否存活
 * @returns {Promise<boolean>}
 */
async function isDaemonAlive() {
  try {
    const res = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

/**
 * 以后台 detached 进程方式启动 Daemon
 *
 * 关键：
 *   - detached: true → Daemon 独立于当前进程组，Skill 退出不影响它
 *   - stdio: 'ignore' → 不绑定当前终端的 stdin/stdout/stderr
 *   - unref() → 当前进程不再等待 Daemon 子进程退出
 */
function spawnDaemon() {
  console.log(`[browser] 🚀 Daemon 未运行，正在自动启动: node ${DAEMON_SCRIPT}`);

  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env },   // 继承环境变量（含 DAEMON_PORT / BROWSER_HEADLESS 等配置）
  });

  child.unref();
  console.log(`[browser] Daemon 进程已分离 (pid=${child.pid})，等待就绪...`);
}

/**
 * 确保 Daemon 可用 — 如果没启动则自动拉起并等待就绪
 * @returns {Promise<void>}
 */
async function ensureDaemon() {
  // 先探测一次
  if (await isDaemonAlive()) {
    return; // 已经活着
  }

  // 拉起 Daemon
  spawnDaemon();

  // 轮询等待就绪
  const deadline = Date.now() + DAEMON_READY_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL);
    if (await isDaemonAlive()) {
      console.log('[browser] ✅ Daemon 就绪');
      return;
    }
  }

  throw new Error(
    `Daemon 自动启动超时（${DAEMON_READY_TIMEOUT / 1000}s 内未响应 /health）！\n` +
    `请检查端口 ${config.daemonPort} 是否被占用，或手动运行: npm run daemon`
  );
}

async function requestJSON(path, { method = 'GET', body, timeoutMs = 5_000 } = {}) {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data;
  try { data = await res.json(); }
  catch (err) { throw new Error(`Daemon ${path} returned invalid JSON: ${err.message}`); }
  if (!res.ok || data?.ok !== true) {
    const detail = data?.detail ? ` (${data.detail})` : '';
    const error = new Error(`Daemon ${path} failed with HTTP ${res.status}: ${data?.error || 'request_failed'}${detail}`);
    error.status = res.status;
    error.code = data?.error || 'request_failed';
    throw error;
  }
  return data;
}

async function acquireSessionLease() {
  const result = await requestJSON('/session/acquire', {
    method: 'POST',
    body: { ownerId: _ownerId, waitMs: SESSION_LEASE_WAIT_MS },
    timeoutMs: SESSION_LEASE_WAIT_MS + 5_000,
  });
  _leaseToken = result.token;
  _leaseExpiresAt = result.expiresAt;
  startLeaseRenewal(result.leaseMs || SESSION_LEASE_MS);
}

async function acquireBrowserEndpoint() {
  return requestJSON('/browser/acquire', { timeoutMs: config.browserAcquireTimeoutMs });
}

function startLeaseRenewal(leaseMs) {
  clearTimeout(_leaseRenewTimer);
  const renew = async () => {
    if (!_leaseToken) return;
    const token = _leaseToken;
    if (Date.now() >= _leaseExpiresAt - 5_000) {
      loseSessionLease(token, 'local lease deadline reached');
      return;
    }
    try {
      const result = await requestJSON('/session/renew', {
        method: 'POST',
        body: { token },
        timeoutMs: Math.min(5_000, Math.floor(leaseMs / 3)),
      });
      // A disconnect/new lease may have happened while this request was in flight.
      if (_leaseToken !== token) return;
      if (!result.ok) throw new Error('lease renewal rejected');
      _leaseExpiresAt = result.expiresAt;
    } catch (err) {
      if (_leaseToken !== token) return;
      if (err.status === 409 || Date.now() >= _leaseExpiresAt - 5_000) {
        loseSessionLease(token, err.message);
        return;
      }
      console.error(`[browser] Session lease renewal failed; retrying before expiry: ${err.message}`);
    }
    const untilSafetyDeadline = _leaseExpiresAt - Date.now() - 5_000;
    const delay = Math.max(1, Math.min(15_000, Math.floor(leaseMs / 4), untilSafetyDeadline));
    _leaseRenewTimer = setTimeout(renew, delay);
    _leaseRenewTimer.unref?.();
  };
  _leaseRenewTimer = setTimeout(renew, Math.max(1_000, Math.min(15_000, Math.floor(leaseMs / 4))));
  _leaseRenewTimer.unref?.();
}

function loseSessionLease(token, reason) {
  if (_leaseToken !== token) return;
  _leaseToken = null;
  _leaseExpiresAt = null;
  clearTimeout(_leaseRenewTimer);
  _leaseRenewTimer = null;
  const browser = _browser;
  _browser = null;

  const cleanup = async () => {
    try {
      if (browser?.isConnected()) await browser.disconnect();
    } catch (err) {
      console.error(`[browser] Lost-lease CDP disconnect failed: ${err.message}`);
    } finally {
      await releaseSessionLease(token);
    }
  };
  _disconnectPromise = Promise.resolve(_disconnectPromise).then(cleanup).finally(() => {
    _disconnectPromise = null;
  });
  console.error(`[browser] Gemini page lease lost; disconnected the old CDP client (${reason})`);
}

async function releaseSessionLease(token) {
  if (!token) return;
  try {
    await requestJSON('/session/release', { method: 'POST', body: { token }, timeoutMs: 5_000 });
  } catch (err) {
    console.error(`[browser] Session lease release failed; it will expire automatically: ${err.message}`);
  }
}

/**
 * 在浏览器中找到 Gemini 标签页，或新开一个
 * @param {import('puppeteer-core').Browser} browser
 * @returns {Promise<import('puppeteer-core').Page>}
 */
async function findOrCreateGeminiPage(browser) {
  const pages = await browser.pages();

  // 优先复用已有的 Gemini 标签页
  for (const page of pages) {
    const url = page.url();
    if (url.includes('gemini.google.com')) {
      console.log('[browser] 命中已有 Gemini 标签页');
      await page.bringToFront();
      return page;
    }
  }

  // 没找到，新开一个
  const page = pages.length > 0 ? pages[0] : await browser.newPage();
  await page.goto('https://gemini.google.com/app', {
    waitUntil: 'networkidle2',
    timeout: 30_000,
  });
  console.log('[browser] 已打开新的 Gemini 标签页');
  return page;
}

/**
 * 确保浏览器可用 — Skill 唯一的对外入口
 *
 * 流程：
 *   1. 当前进程已连着 → 直接复用
 *   2. 检查 Daemon 是否存活，未存活则自动拉起
 *   3. 向 Daemon 发 HTTP 请求索要 wsEndpoint
 *   4. 通过 WebSocket 直连 Chrome CDP
 *   5. 找到 / 新开 Gemini 标签页
 *
 * @returns {Promise<{browser: import('puppeteer-core').Browser, page: import('puppeteer-core').Page}>}
 */
async function ensureBrowserInternal() {
  if (_disconnectPromise) await _disconnectPromise;

  // 1. 复用已有连接
  if (_browser?.isConnected() && _leaseToken) {
    const page = await findOrCreateGeminiPage(_browser);
    return { browser: _browser, page };
  }

  // A lost CDP connection must not leave this process waiting on its stale lease.
  if (_leaseToken) {
    const staleToken = _leaseToken;
    _leaseToken = null;
    _leaseExpiresAt = null;
    clearTimeout(_leaseRenewTimer);
    _leaseRenewTimer = null;
    await releaseSessionLease(staleToken);
  }
  if (_browser && !_browser.isConnected()) _browser = null;

  // Ensure a Daemon is present before taking the cross-process page lease.
  await ensureDaemon();

  let acquiredToken = null;
  try {
    await acquireSessionLease();
    acquiredToken = _leaseToken;
    console.log(`[browser] 获得 Gemini 页面 lease (${_ownerId})，正在请求浏览器连接...`);

    const acquireData = await acquireBrowserEndpoint();

    // If the old CDP connection remains valid, reuse it under the newly acquired lease.
    if (!_browser?.isConnected()) {
      console.log('[browser] 从 Daemon 获取到 wsEndpoint，正在建立 CDP 直连...');
      _browser = await puppeteer.connect({
        browserWSEndpoint: acquireData.wsEndpoint,
        defaultViewport: null,
        protocolTimeout: config.browserProtocolTimeout,
      });
    }

    const page = await findOrCreateGeminiPage(_browser);
    console.log(`[browser] CDP 直连成功，pid=${acquireData.pid}`);
    return { browser: _browser, page };
  } catch (err) {
    if (_browser && !_browser.isConnected()) _browser = null;
    clearTimeout(_leaseRenewTimer);
    _leaseRenewTimer = null;
    _leaseToken = null;
    _leaseExpiresAt = null;
    await releaseSessionLease(acquiredToken);
    throw new Error(`Daemon 已启动但获取浏览器失败！\n底层报错: ${err.message}`);
  }
}

const ensureBrowserSingleFlight = createSingleFlight(ensureBrowserInternal);

export function ensureBrowser() {
  return ensureBrowserSingleFlight();
}

/**
 * 断开 WebSocket 连接（不关闭浏览器）
 *
 * 注意：绝不能调用 browser.close()！
 * 浏览器的生杀大权已经移交给 Daemon 的 TTL 倒计时了。
 */
export function disconnect() {
  if (_disconnectPromise) return _disconnectPromise;

  const browser = _browser;
  const token = _leaseToken;
  _browser = null;
  _leaseToken = null;
  _leaseExpiresAt = null;
  clearTimeout(_leaseRenewTimer);
  _leaseRenewTimer = null;

  _disconnectPromise = (async () => {
    try {
      if (browser) {
        // disconnect() drops only this CDP client; it never closes the Daemon-owned browser.
        await browser.disconnect();
        console.log('[browser] 已断开 CDP 连接（浏览器仍由 Daemon 守护）');
      }
    } finally {
      // Do not hand the page to another client until the old CDP socket is closed.
      await releaseSessionLease(token);
    }
  })().finally(() => {
    _disconnectPromise = null;
  });
  return _disconnectPromise;
}
