import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const logPath = process.env.MCP_TEST_LOG;
const outputDir = process.env.MCP_TEST_OUTPUT_DIR;
let disconnectInFlight = null;
let activeOperations = 0;

function record(event, data = {}) {
  appendFileSync(logPath, `${JSON.stringify({ event, ...data })}\n`);
}

function defaultResult(method, args) {
  switch (method) {
    case 'checkLogin': return { ok: true, loggedIn: true, barText: 'fixture' };
    case 'switchToModel': return { ok: true, previousModel: 'flash' };
    case 'setThinkingDepth': return { ok: true, previousLevel: 'medium' };
    case 'generateImage': return { ok: true, filePath: join(outputDir, 'fixture.png') };
    case 'sendAndWait': return { ok: true, elapsed: 1, text: 'fixture response' };
    case 'getAllImages': return { ok: true, total: 0, newCount: 0, images: [] };
    case 'extractImageBase64': return { ok: true, method: 'fixture', dataUrl: 'data:image/png;base64,AA==' };
    case 'downloadFullSizeImage': return { ok: true, index: 0, total: 1, filePath: 'fixture.png', suggestedFilename: 'fixture.png' };
    case 'shareLatestImage': return { ok: true, link: 'https://gemini.google.com/share/fixture' };
    case 'getAllTextResponses': return { ok: true, responses: [] };
    case 'getLatestTextResponse': return { ok: true, text: 'fixture response' };
    case 'navigateTo': return { ok: true, url: args[0], elapsed: 1 };
    case 'reloadPage': return { ok: true, elapsed: 1 };
    case 'probe': return { ok: true };
    default: return { ok: true };
  }
}

function createOps() {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined;
      return async (...args) => {
        activeOperations++;
        record('op:start', { method: String(property), args, activeOperations });
        const delayMs = Number(process.env.MCP_TEST_OP_DELAY_MS || 2);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        let control = {};
        try { control = JSON.parse(readFileSync(process.env.MCP_TEST_CONTROL, 'utf8')); } catch {}
        if (control.throwMethod === String(property)) {
          activeOperations--;
          record('op:throw', { method: String(property), activeOperations });
          throw new Error(`fixture failure in ${String(property)}`);
        }
        if (control.failMethod === String(property)) {
          activeOperations--;
          record('op:fail', { method: String(property), error: control.failError || 'fixture operation failed', activeOperations });
          return { ok: false, error: control.failError || 'fixture operation failed' };
        }
        const result = defaultResult(String(property), args);
        activeOperations--;
        record('op:end', { method: String(property), activeOperations });
        return result;
      };
    },
  });
}

export function createAtlasProvider() {
  return {};
}

export async function createGeminiSession() {
  record('session:create');
  return { ops: createOps() };
}

export function disconnect() {
  if (!disconnectInFlight) {
    record('disconnect:start');
    disconnectInFlight = new Promise(resolve => setTimeout(resolve, 5)).finally(() => {
      record('disconnect:end');
      disconnectInFlight = null;
    });
  }
  return disconnectInFlight;
}
