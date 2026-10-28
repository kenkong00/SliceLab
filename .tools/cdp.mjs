/**
 * 极简 CDP 驱动：用本机 Edge 的无头模式打开页面，
 * 执行任意 JS、点击元素、截图。用于自查前端界面。
 *
 * 用法: node .tools/cdp.mjs <脚本文件.json>
 *   脚本文件是 [{ "eval": "..." } | { "click": "selector" } | { "wait": 1500 } | { "shot": "a.png" }]
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9400 + Math.floor(Math.random() * 300);
const profile = path.join(os.tmpdir(), 'agg-cdp-' + crypto.randomBytes(4).toString('hex'));
const shotDir = path.resolve('.shots');
fs.mkdirSync(shotDir, { recursive: true });

const width = Number(process.env.VW || 1600);
const height = Number(process.env.VH || 1000);

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  'about:blank'
], { stdio: 'ignore', windowsHide: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const j = await r.json();
      const page = j.find(t => t.type === 'page');
      if (page) return page;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('无法连接 Edge 调试端口');
}

let ws;
let msgId = 0;
const waiters = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    setTimeout(() => {
      if (waiters.has(id)) { waiters.delete(id); reject(new Error(method + ' 超时')); }
    }, 60000);
  });
}

async function main() {
  const t = await targets();
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) {
      const w = waiters.get(m.id);
      waiters.delete(m.id);
      if (m.error) w.reject(new Error(JSON.stringify(m.error)));
      else w.resolve(m.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width <= 860
  });

  const url = process.env.URL || 'http://localhost:5199';
  await send('Page.navigate', { url });
  await sleep(Number(process.env.NAVWAIT || 4000));

  const steps = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  for (const st of steps) {
    if (st.wait) { await sleep(st.wait); continue; }
    if (st.shot) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!st.full });
      fs.writeFileSync(path.join(shotDir, st.shot), Buffer.from(r.data, 'base64'));
      console.log('[shot] ' + st.shot);
      continue;
    }
    if (st.click) {
      const r = await send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(st.click)}); if (!el) return 'NOT_FOUND'; el.click(); return 'CLICKED'; })()`,
        returnByValue: true
      });
      console.log('[click] ' + st.click + ' -> ' + r.result.value);
      continue;
    }
    if (st.eval) {
      const r = await send('Runtime.evaluate', {
        expression: st.eval,
        returnByValue: true,
        awaitPromise: true
      });
      const v = r.result && r.result.value;
      console.log('[eval] ' + (typeof v === 'string' ? v : JSON.stringify(v)));
      continue;
    }
  }
}

main()
  .catch(e => { console.error('ERROR: ' + e.message); })
  .finally(async () => {
    try { ws && ws.close(); } catch { /* ignore */ }
    await sleep(200);
    // 只杀自己启动的进程树，避免影响用户正在使用的 Edge
    try {
      spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* ignore */ }
    await sleep(800);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(0);
  });
