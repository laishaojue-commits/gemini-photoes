export async function ensureBrowserForDaemon() {
  throw new Error('browser engine must not be invoked by lease HTTP tests');
}

export function getBrowser() { return null; }
export async function terminateBrowser() {}
export function onBrowserExit() {}
