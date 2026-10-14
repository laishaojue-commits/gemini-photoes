import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const helper = name => pathToFileURL(join(here, name)).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/src/mcp-server.js')) {
      if (specifier === './index.js') return { url: helper('mcp-index-stub.mjs'), shortCircuit: true };
      if (specifier === './config.js') return { url: helper('mcp-config-stub.mjs'), shortCircuit: true };
      if (specifier === './util.js') return { url: helper('mcp-util-stub.mjs'), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
