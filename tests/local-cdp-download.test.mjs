import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer as createPortServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { removeOwnedTempCase } from './helpers/temp-case.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/s9sAAAAASUVORK5CYII=', 'base64');

function browserExecutable() {
  const candidates = [
    process.env.BROWSER_PATH,
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || null;
}

async function reservePort() {
  const server = createPortServer();
  await new Promise((resolveListen, reject) => server.listen(0, '127.0.0.1', resolveListen).once('error', reject));
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

test('isolated local CDP download is scoped to the Browser session and does not double-click a slow response', { skip: process.env.RUN_LOCAL_CDP_DOWNLOAD !== '1' }, async t => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('No installed Edge/Chrome executable found at the standard paths; no browser was downloaded.');
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'gemini-local-cdp-download-'));
  const userDataDir = join(tempRoot, 'isolated-profile');
  const outputDir = join(tempRoot, 'downloads');
  const oldOutputDir = process.env.OUTPUT_DIR;
  process.env.OUTPUT_DIR = outputDir;
  let clickCount = 0;
  let downloadRequestCount = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const source = `${origin}/fixture.png?width=512`;
      const download = `${origin}/fixture.png?width=1024`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><style>body{margin:30px}#image-scope{width:220px;height:180px;border:1px solid #777}img{width:120px;height:120px}button{display:block;width:180px;height:32px}</style><main><section id="image-scope"><img class="image loaded" src="${source}"><button data-test-id="download-generated-image-button" data-url="${download}" onclick="window.clickCount++;const a=document.createElement('a');a.href='${download}';a.download='fixture.png';a.click()">Download full image</button></section></main><script>window.clickCount=0</script>`);
      return;
    }
    if (url.pathname === '/fixture.png') {
      const isDownload = url.searchParams.get('width') === '1024';
      if (isDownload) downloadRequestCount++;
      const send = () => {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          ...(isDownload ? { 'Content-Disposition': 'attachment; filename="fixture.png"' } : {}),
        });
        res.end(png);
      };
      if (isDownload) setTimeout(send, 1600);
      else send();
      return;
    }
    res.writeHead(404).end();
  });

  let playwrightBrowser;
  let playwrightContext;
  let puppeteerBrowser;
  try {
    await new Promise((resolveListen, reject) => server.listen(0, '127.0.0.1', resolveListen).once('error', reject));
    const cdpPort = await reservePort();
    const playwrightModulePath = process.env.GEMINI_PLAYWRIGHT_MODULE_PATH;
    const playwrightModule = playwrightModulePath
      ? await import(pathToFileURL(playwrightModulePath).href)
      : await import('playwright');
    const chromium = playwrightModule.chromium || playwrightModule.default?.chromium;
    assert.ok(chromium, 'Playwright module must export chromium');
    playwrightContext = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: true,
      timeout: 15_000,
      args: [
        `--remote-debugging-port=${cdpPort}`,
        '--disable-background-networking',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    playwrightBrowser = playwrightContext.browser();
    assert.ok(playwrightBrowser, 'Playwright persistent context must expose its isolated browser');
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    let cdpReady = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const version = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(300) });
        if (version.ok) { cdpReady = true; break; }
      } catch {}
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
    }
    assert.equal(cdpReady, true, 'isolated Playwright Chromium should expose its unique local CDP port');

    // Playwright owns the isolated browser/profile and validates the fixture UI;
    // the production Puppeteer API connects only to this throwaway CDP endpoint.
    const playwrightPage = await playwrightContext.newPage();
    await playwrightPage.setViewportSize({ width: 800, height: 600 });
    await playwrightPage.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle', timeout: 10_000 });
    const imageReady = await playwrightPage.evaluate(() => {
      const image = document.querySelector('img.image.loaded');
      return !!image && image.complete && image.naturalWidth > 0;
    });
    assert.equal(imageReady, true);

    const { default: puppeteer } = await import('puppeteer-core');
    puppeteerBrowser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
    const puppeteerPage = (await puppeteerBrowser.pages()).find(page => page.url().startsWith(`http://127.0.0.1:${server.address().port}/`));
    assert.ok(puppeteerPage, 'Puppeteer must observe the same locally served page over CDP');

    const { createOps } = await import('../src/gemini-ops.js');
    const ops = createOps(puppeteerPage);
    const result = await ops.downloadFullSizeImage({ index: 0, timeout: 10_000 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.index, 0);
    assert.equal(result.total, 1);
    assert.ok(existsSync(result.filePath));
    assert.ok(statSync(result.filePath).size > 0);
    assert.match(result.filePath, /gemini_fullsize_[0-9a-f-]+\.png$/i);
    assert.ok(readFileSync(result.filePath).equals(png));
    assert.equal(await playwrightPage.evaluate(() => window.clickCount), 1, 'the real page button must be clicked once');
    assert.equal(downloadRequestCount, 1, 'the local server must see exactly one download request');
  } finally {
    try { await puppeteerBrowser?.disconnect(); } catch {}
    try { await playwrightContext?.close(); } catch {}
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
    removeOwnedTempCase(tempRoot, 'gemini-local-cdp-download-');
    if (oldOutputDir === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = oldOutputDir;
  }
});
