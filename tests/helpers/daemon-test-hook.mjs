import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const helper = name => pathToFileURL(join(here, name)).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './engine.js' && context.parentURL?.startsWith(new URL('../../src/daemon/', import.meta.url).href)) {
      return { url: helper('daemon-engine-stub.mjs'), shortCircuit: true };
    }
    if (specifier === '../config.js' && /\/src\/daemon\/(?:server|session-lease)\.js$/.test(context.parentURL || '')) {
      return { url: helper('daemon-config-stub.mjs'), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
