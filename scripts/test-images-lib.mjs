// テスト画像の生成・評価で共通に使うヘルパー。
// Vite dev サーバーの起動と、Playwright 用 Chromium の探索。

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const PORT = Number(process.env.EVAL_PORT ?? 5173);
export const BASE = `http://localhost:${PORT}`;

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const dir = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (existsSync(dir)) {
    const dirs = readdirSync(dir)
      .filter((name) => name.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const name of dirs) {
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const exe = path.join(dir, name, sub, 'chrome');
        if (existsSync(exe)) return exe;
      }
    }
  }
  throw new Error(
    'Chromium が見つかりません。`npx playwright install chromium` を実行するか、CHROME_PATH を指定してください。',
  );
}

async function isUp() {
  try {
    const res = await fetch(`${BASE}/eval.html`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 既に起動していれば null、自分で起動した場合は child_process を返す */
export async function ensureServer() {
  if (await isUp()) return null;
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => {
    log += String(d);
  });
  child.stderr.on('data', (d) => {
    log += String(d);
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (await isUp()) return child;
  }
  child.kill();
  throw new Error(`Vite が起動しませんでした:\n${log}`);
}

export async function launchBrowser(chromium) {
  return chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // MediaPipe の GPU delegate が使えない環境でも CPU で動くようにする
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
    ],
  });
}

export function stopServer(child) {
  if (child) child.kill('SIGTERM');
}
