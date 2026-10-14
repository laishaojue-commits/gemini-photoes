/**
 * lifecycle.js — 生命周期控制器
 *
 * 职责：
 *   管理"惰性销毁"定时器。每次收到请求就 resetHeartbeat()（续命）；
 *   超时未活动则终止浏览器并退出 Daemon 进程，释放全部系统资源。
 *
 * 为什么超时后连 Daemon 一起退出：
 *   Daemon 由 browser.js 的 ensureBrowser() 按需 spawn（detached + unref），
 *   下次 Skill 调用时会自动重新拉起。闲置时留一个空壳进程占端口没有意义。
 */
import { terminateBrowser } from './engine.js';
import { sessionLeaseManager } from './session-lease.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分钟

let _idleTimer = null;
let _ttlMs = DEFAULT_TTL_MS;
let _lastHeartbeat = 0;
let _httpServer = null;

/**
 * 设置 TTL（可通过环境变量覆盖）
 * @param {number} ms
 */
export function setTTL(ms) {
  _ttlMs = ms > 0 ? ms : DEFAULT_TTL_MS;
}

/**
 * 注入 HTTP server 引用，供超时退出时关闭
 * @param {import('node:http').Server} server
 */
export function setServer(server) {
  _httpServer = server;
}

/**
 * 重置心跳定时器 — 每次 API 调用时执行
 */
export function resetHeartbeat() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _lastHeartbeat = Date.now();

  _idleTimer = setTimeout(async () => {
    if (sessionLeaseManager.getActiveLeaseCount() > 0) {
      console.log('[lifecycle] Gemini session lease still active; extending browser lifetime');
      resetHeartbeat();
      return;
    }
    console.log(`[lifecycle] 💤 ${(_ttlMs / 60000).toFixed(0)} 分钟未活动，终止浏览器并退出 Daemon`);
    await terminateBrowser();

    // 关闭 HTTP 服务器，停止接受新连接
    if (_httpServer) {
      _httpServer.close();
      _httpServer = null;
    }

    _idleTimer = null;
    console.log('[lifecycle] ✅ Daemon 进程退出（下次 Skill 调用时会自动重新拉起）');
    process.exit(0);
  }, _ttlMs);

  // 不用 unref — 定时器需要保持 Daemon 进程存活，直到超时或被续命
  // （Daemon 是后台常驻进程，不像 Skill 脚本需要及时退出）
}

/**
 * 取消定时器（用于 Daemon 关闭时清理）
 */
export function cancelHeartbeat() {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
}

/**
 * 获取生命周期状态
 */
export function getLifecycleInfo() {
  const now = Date.now();
  const idleSec = _lastHeartbeat > 0 ? Math.round((now - _lastHeartbeat) / 1000) : -1;
  const remainingSec = _lastHeartbeat > 0
    ? Math.max(0, Math.round((_lastHeartbeat + _ttlMs - now) / 1000))
    : -1;

  return {
    ttlMs: _ttlMs,
    lastHeartbeat: _lastHeartbeat > 0 ? new Date(_lastHeartbeat).toISOString() : null,
    idleSeconds: idleSec,
    remainingSeconds: remainingSec,
  };
}
