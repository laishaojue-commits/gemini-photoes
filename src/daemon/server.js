/**
 * server.js — Browser Daemon 入口
 *
 * 一个极简的 HTTP 微服务，管理浏览器进程的生命周期。
 *
 * 启动方式：
 *   node src/daemon/server.js
 *   DAEMON_PORT=40225 node src/daemon/server.js
 *
 * API 端点：
 *   GET  /browser/acquire  — 确保浏览器可用，返回 wsEndpoint（续命）
 *   GET  /browser/status   — 查询浏览器状态（不续命）
 *   POST /browser/release  — 主动销毁浏览器
 *   GET  /health           — Daemon 健康检查
 */
import { createServer } from 'node:http';
import {
  handleAcquire, handleStatus, handleRelease, handleHealth,
  handleSessionAcquire, handleSessionRenew, handleSessionRelease,
} from './handlers.js';
import { setTTL, cancelHeartbeat, setServer, resetHeartbeat } from './lifecycle.js';
import { terminateBrowser, onBrowserExit } from './engine.js';
import { sessionLeaseManager } from './session-lease.js';
import config from '../config.js';

// ── 配置（统一从 config.js 读取） ──
const PORT = config.daemonPort;
const TTL_MS = config.daemonTTL;

setTTL(TTL_MS);
sessionLeaseManager.setOnChange(() => resetHeartbeat());

// ── 路由表 ──
const routes = {
  'GET /browser/acquire': handleAcquire,
  'GET /browser/status': handleStatus,
  'POST /browser/release': handleRelease,
  'POST /session/acquire': handleSessionAcquire,
  'POST /session/renew': handleSessionRenew,
  'POST /session/release': handleSessionRelease,
  'GET /health': handleHealth,
};

// ── HTTP 服务器 ──
const server = createServer((req, res) => {
  const { method, url } = req;
  // 去掉 query string
  const path = (url || '/').split('?')[0];
  const routeKey = `${method} ${path}`;

  const handler = routes[routeKey];
  if (handler) {
    handler(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found', path }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // 注入 server 引用给 lifecycle，超时退出时优雅关闭 HTTP 服务
  setServer(server);

  // 浏览器被用户手动关闭时，Daemon 也跟着退出
  onBrowserExit(() => {
    console.log('[daemon] 🛑 浏览器已关闭，Daemon 跟随退出（下次 Skill 调用时会自动重新拉起）');
    cancelHeartbeat();
    server.close();
    process.exit(0);
  });

  console.log(`[daemon] 🚀 Browser Daemon 已启动 — http://127.0.0.1:${PORT}`);
  console.log(`[daemon] ⏱  闲置 TTL: ${(TTL_MS / 60000).toFixed(0)} 分钟`);
  console.log(`[daemon] 🖥  无头模式: ${config.browserHeadless ? '是' : '否'}`);
  console.log(`[daemon] 🔌 CDP 端口: ${config.browserDebugPort}`);
  console.log(`[daemon]    GET  /browser/acquire  — 获取/启动浏览器`);
  console.log(`[daemon]    GET  /browser/status   — 查询浏览器状态`);
  console.log(`[daemon]    POST /browser/release  — 销毁浏览器`);
  console.log(`[daemon]    POST /session/acquire — 获取 Gemini 页互斥 lease`);
  console.log(`[daemon]    POST /session/renew   — 续租 Gemini 页互斥 lease`);
  console.log(`[daemon]    POST /session/release  — 释放 Gemini 页互斥 lease`);
  console.log(`[daemon]    GET  /health           — 健康检查`);
});

// ── 优雅退出：系统信号拦截 ──
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

SIGNALS.forEach(sig => {
  process.on(sig, async () => {
    console.log(`\n[daemon] 🛑 收到 ${sig}，开始优雅退出...`);

    // 1. 停止接收新请求
    server.close();

    // 2. 取消闲置定时器
    cancelHeartbeat();

    // 3. 终止浏览器
    await terminateBrowser();

    console.log('[daemon] ✅ 清理完毕，进程退出');
    process.exit(0);
  });
});

// ── 未捕获异常兜底 ──
process.on('uncaughtException', (err) => {
  console.error('[daemon] ❌ 未捕获异常:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[daemon] ❌ 未处理的 Promise 拒绝:', reason);
});
