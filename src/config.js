/**
 * config.js — 统一配置中心
 *
 * 所有可配置项集中在这里，从环境变量读取，提供合理默认值。
 * 其他模块一律从 config 取值，不自己硬编码。
 *
 * 环境变量来源（优先级从高到低）：
 *   1. 进程环境变量（process.env）
 *   2. .env.development（开发环境，git-ignored）
 *   3. .env（基础配置，可提交到 git）
 *   4. 代码默认值
 *
 * .env 文件加载说明：
 *   - 本模块内置了轻量级 parseEnvFile 解析器，零外部依赖。
 *   - 作为 skill 库被 import 使用，不应要求调用方修改启动命令或安装额外依赖。
 *   - 如果调用方已通过以下方式加载了 .env，本模块也能无缝工作（process.env 优先级最高）：
 *     · Node.js ≥ v20.6.0: node --env-file=.env --env-file=.env.development app.js
 *     · dotenv 库: dotenv.config({ path: ['.env.development', '.env'] })
 */
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── 手动加载 .env 文件（不依赖 dotenv） ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

/**
 * 解析 .env 文件内容为 key-value 对象
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf-8');
  const result = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // 去掉引号包裹
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

// 加载顺序：.env.development 优先 → .env 兜底
// 已存在的 process.env 不会被覆盖（进程环境变量优先级最高）
// 因为是 "不覆盖" 策略，所以高优先级的文件先加载
const devEnv = parseEnvFile(join(projectRoot, '.env.development'));
const baseEnv = parseEnvFile(join(projectRoot, '.env'));

// 优先级：process.env > .env.development > .env > 代码默认值
for (const [key, value] of Object.entries(devEnv)) {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}
for (const [key, value] of Object.entries(baseEnv)) {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}

const env = process.env;
const browserProtocolTimeout = envInt('BROWSER_PROTOCOL_TIMEOUT', 60_000);
const browserAcquireTimeoutMs = Math.max(
  90_000,
  browserProtocolTimeout + 30_000,
  envInt('BROWSER_ACQUIRE_TIMEOUT_MS', 0),
);

/** 辅助：读取布尔型环境变量 */
function envBool(key, fallback) {
  const val = env[key];
  if (val === undefined || val === '') return fallback;
  return val === 'true' || val === '1';
}

/** 辅助：读取数字型环境变量 */
function envInt(key, fallback) {
  const val = env[key];
  if (val === undefined || val === '') return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** 辅助：读取字符串环境变量 */
function envStr(key, fallback) {
  const val = env[key];
  return (val !== undefined && val !== '') ? val : fallback;
}

// ── 导出配置 ──

const config = {
  /** 浏览器可执行文件路径，支持 Chrome / Edge / Chromium（不设则自动检测） */
  browserPath: envStr('BROWSER_PATH', undefined),

  /**
   * CDP 远程调试端口
   *
   * 默认 40821，作为 WJZ_P 所有 skill 的统一 CDP 端口。
   * 使用独立端口的原因：
   *   1. 不信任其他浏览器实例的反爬措施，自己启动并控制的浏览器反爬最保险。
   *   2. 避免与用户手动启动的调试浏览器或其他工具的端口冲突。
   *   3. 跨 skill 共享同一个浏览器实例，多个 skill 各用各的 tab。
   */
  browserDebugPort: envInt('BROWSER_DEBUG_PORT', 40821),

  /** 浏览器用户数据目录（不设则自动解析，见 browser.js resolveUserDataDir） */
  browserUserDataDir: envStr('BROWSER_USER_DATA_DIR', undefined),

  /** 是否无头模式 */
  browserHeadless: envBool('BROWSER_HEADLESS', false),

  /** CDP 协议超时时间（ms） */
  browserProtocolTimeout,

  /** Daemon 首次冷启动浏览器的 HTTP acquire 超时时间（ms） */
  browserAcquireTimeoutMs,

  /** 截图 / 图片输出目录 */
  outputDir: envStr('OUTPUT_DIR', join(projectRoot, 'gemini-image')),

  // ── Atlas Cloud Provider 配置 ──

  /** Atlas Cloud OpenAI 兼容 API Base URL */
  atlasBaseUrl: envStr('ATLAS_BASE_URL', 'https://api.atlascloud.ai/v1'),

  /** Atlas Cloud API Key */
  atlasApiKey: envStr('ATLAS_API_KEY', undefined),

  /** Atlas Cloud 默认模型 */
  atlasDefaultModel: envStr('ATLAS_MODEL', 'openai/gpt-4o-mini'),

  /** Atlas Cloud 请求超时（ms） */
  atlasRequestTimeoutMs: envInt('ATLAS_REQUEST_TIMEOUT_MS', 60_000),

  // ── Daemon 配置 ──

  /** Daemon HTTP 服务端口 */
  daemonPort: envInt('DAEMON_PORT', 40225),

  /** Daemon 闲置超时时间（ms），超时后自动终止浏览器释放资源 */
  daemonTTL: envInt('DAEMON_TTL_MS', 30 * 60 * 1000),

  /** Gemini 单页互斥 lease 时长与跨进程等待上限（ms） */
  sessionLeaseMs: envInt('SESSION_LEASE_MS', 10 * 60 * 1000),
  sessionLeaseWaitMs: envInt('SESSION_LEASE_WAIT_MS', 4 * 60 * 1000),
};

export default config;
