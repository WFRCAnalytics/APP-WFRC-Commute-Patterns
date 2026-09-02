// Playwright script: boot the Vite dev server, capture light + dark
// screenshots into docs/, then shut the server down (freeing the port).
//
// Usage:
//   node scripts/screenshot.cjs                 # default port 5174
//   node scripts/screenshot.cjs --port 5180
//   PORT=5180 node scripts/screenshot.cjs
//   node scripts/screenshot.cjs --url http://localhost:5173/APP-WFRC-Commute-Patterns/
//
// With --url the script targets an already-running server and neither starts
// nor stops anything. Otherwise it spawns `vite --port <n> --strictPort`,
// waits for it to answer, shoots, and always tears it down on the way out
// (including on error or Ctrl+C).

const { chromium } = require('playwright');
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const BASE_PATH = '/APP-WFRC-Commute-Patterns/'; // must match vite.config.js `base`

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};

const externalUrl = argValue('url');
const port = Number(argValue('port') || process.env.PORT || 5174);
const baseUrl = externalUrl || `http://localhost:${port}${BASE_PATH}`;

function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const attempt = () => {
      if (settled) return;
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) done(resolve);
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (settled) return;
      if (Date.now() > deadline) done(reject, new Error(`Dev server not ready at ${url} after ${timeoutMs}ms`));
      else setTimeout(attempt, 500);
    };
    attempt();
  });
}

function startViteServer() {
  // Run vite's JS entry with the current node — no shell, so no arg-escaping
  // pitfalls and no .cmd shim to orphan on Windows.
  const viteEntry = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const proc = spawn(process.execPath, [viteEntry, '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  proc.on('error', (err) => { console.error('Failed to start vite:', err.message); });
  return proc;
}

function stopViteServer(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  if (process.platform === 'win32') {
    // SIGTERM is unreliable for child trees on Windows; taskkill /T is not.
    try { execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
  } else {
    proc.kill('SIGTERM');
  }
}

(async () => {
  const server = externalUrl ? null : startViteServer();
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopViteServer(server);
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  process.on('exit', cleanup);

  const browser = await chromium.launch();

  async function shoot(theme, outPath) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const page = await ctx.newPage();

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // Wait for the loading overlay to disappear (DuckDB + parquet)
    await page.waitForSelector('.sidebar-loading', { state: 'detached', timeout: 60000 }).catch(() => {});
    // Extra settle time for map tiles + flow arcs
    await page.waitForTimeout(3500);

    if (theme === 'dark') {
      await page.locator('#theme-toggle').click();
      await page.waitForTimeout(1500);
    }

    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`Saved ${path.relative(REPO_ROOT, outPath)}`);
    await ctx.close();
  }

  try {
    await waitForServer(baseUrl);
    await shoot('light', path.join(REPO_ROOT, 'docs', 'screenshot-light.png'));
    await shoot('dark',  path.join(REPO_ROOT, 'docs', 'screenshot-dark.png'));
  } finally {
    await browser.close();
    cleanup();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
