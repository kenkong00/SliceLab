// 验证 HMR 守卫的「token 变了 → 自动刷新」链路
// 思路：页面加载后调用 window.__hmrGuard.simulateStaleToken() 制造一次 token 不一致，
//       守卫下次轮询应发现并刷新页面（刷新后打印的标记会丢失）。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.argv[2] || "http://localhost:5180";
const PORT = 9346;
const PROFILE = "F:\\TREA work\\window操作界面\\SliceLab\\.edge-guardself";

const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu-sandbox", "--no-sandbox",
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--hide-scrollbars", "--disable-extensions", "--mute-audio",
  "--window-size=1400,900", `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`, "about:blank",
], { stdio: "ignore" });

let ws, id = 0; const pending = new Map();
let t0 = Date.now();
const log = (s) => console.log(`+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s  ${s}`);
function send(method, params = {}) {
  const msg = { id: ++id, method, params };
  ws.send(JSON.stringify(msg));
  return Promise.race([
    new Promise((res, rej) => pending.set(msg.id, { res, rej })),
    sleep(10000).then(() => { pending.delete(msg.id); return null; }),
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
    if (m.method === "Runtime.consoleAPICalled") {
      log(`[${m.params.type}] ${(m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 160)}`);
    }
  };
  t0 = Date.now();
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: BASE });
  // 等守卫真正挂上（首次加载要转换大量模块，可能要十几秒）
  let has = null;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    has = await send("Runtime.evaluate", { expression: `typeof window.__hmrGuard`, returnByValue: true });
    log(`守卫钩子: ${has?.result?.value}`);
    if (has?.result?.value === "object") break;
  }
  if (has?.result?.value !== "object") { log("守卫始终未挂载，放弃"); return; }

  const mark = await send("Runtime.evaluate", {
    expression: `(function(){ window.__mark='M'+Math.random().toString(36).slice(2,8); window.__hmrGuard.simulateStaleToken(); return window.__mark; })()`,
    returnByValue: true,
  });
  const markVal = mark?.result?.value;
  log(`阶段1 标记 = ${markVal}，已调用 simulateStaleToken()`);

  await sleep(40000);

  const after = await send("Runtime.evaluate", { expression: `window.__mark || '(已刷新，标记丢失)'`, returnByValue: true });
  const afterVal = after?.result?.value;
  log(`阶段2 标记 = ${afterVal}`);
  log(afterVal === markVal ? "结论：页面未刷新 ❌" : "结论：页面已自动刷新 ✅");
}
main().catch((e) => console.error("FAIL", e)).finally(() => { try { child.kill(); } catch {} setTimeout(() => process.exit(0), 500); });
