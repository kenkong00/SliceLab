// 验证：dev server 重启导致 HMR WebSocket token 失效后，页面能否自动刷新并恢复连接
//
// 用法（两步）：
//   1) node tools/ws-recover-test.mjs http://localhost:5180 wait
//   2) 在脚本打印"等待外部触发重启…"之后，手动改动 vite.config.ts 触发 vite 重启
//
// 判定：阶段2 拿不到阶段1 打的 window.__mark → 说明页面自动刷新了；
//       时间线里出现 [SliceLab] 检测到… + 新的 [vite] connected → HMR 已恢复。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.argv[2] || "http://localhost:5180";
const PORT = 9343;
const PROFILE = "F:\\TREA work\\window操作界面\\SliceLab\\.edge-wsrecover";
const WATCHDOG_MS = 170_000;

const watchdog = setTimeout(() => {
  console.log("!! 看门狗超时，强制结束");
  process.exit(0);
}, WATCHDOG_MS);
watchdog.unref?.();

const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu-sandbox", "--no-sandbox",
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--hide-scrollbars", "--disable-extensions", "--mute-audio",
  "--window-size=1400,900", `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`, "about:blank",
], { stdio: "ignore" });

let ws, id = 0; const pending = new Map();
let t0 = Date.now();
function log(s) { console.log(`+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s  ${s}`); }
function send(method, params = {}) {
  const msg = { id: ++id, method, params };
  ws.send(JSON.stringify(msg));
  return Promise.race([
    new Promise((res, rej) => pending.set(msg.id, { res, rej })),
    sleep(8000).then(() => { pending.delete(msg.id); return null; }),
  ]);
}

async function main() {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") log(`[${m.params.type}] ${(m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 150)}`);
    if (m.method === "Log.entryAdded") log(`[log:${m.params.entry.level}] ${m.params.entry.text.slice(0, 150)}`);
    if (m.method === "Network.webSocketCreated") log(`[ws:created] ${m.params.url}`);
    if (m.method === "Network.webSocketHandshakeResponseReceived") log(`[ws:handshake] HTTP ${m.params.response.status}`);
    if (m.method === "Network.webSocketFrameError") log(`[ws:error] ${m.params.errorMessage}`);
    if (m.method === "Network.loadingFailed") log(`[net:failed] ${m.params.errorText || ""}`);
  };
  t0 = Date.now();
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable");
  await send("Page.navigate", { url: BASE });
  await sleep(8000);

  const mark = await send("Runtime.evaluate", {
    expression: `(function(){ window.__mark='M'+Math.random().toString(36).slice(2,8); return window.__mark; })()`,
    returnByValue: true,
  });
  const markVal = mark?.result?.value;
  log(`阶段1 页面标记 = ${markVal}`);
  log("等待外部触发重启…（现在去改 vite.config.ts）");

  await sleep(110000);

  const after = await send("Runtime.evaluate", { expression: `window.__mark || '(已刷新，标记丢失)'`, returnByValue: true });
  const afterVal = after?.result?.value;
  log(`阶段2 页面标记 = ${afterVal}`);
  log(afterVal === markVal ? "结论：页面未刷新（守卫没触发）" : "结论：页面已自动刷新 ✅");
}
main().catch((e) => console.error("FAIL", e)).finally(() => { try { child.kill(); } catch {} setTimeout(() => process.exit(0), 500); });
