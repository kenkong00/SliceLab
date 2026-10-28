// 检查 hmrGuard 是否被浏览器加载，以及它依赖的 token 提取逻辑是否可用
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.argv[2] || "http://localhost:5180";
const PORT = 9344;
const PROFILE = "F:\\TREA work\\window操作界面\\SliceLab\\.edge-guardprobe";

const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu-sandbox", "--no-sandbox",
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--hide-scrollbars", "--disable-extensions", "--mute-audio",
  "--window-size=1400,900", `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`, "about:blank",
], { stdio: "ignore" });

let ws, id = 0; const pending = new Map();
function send(method, params = {}) {
  const msg = { id: ++id, method, params };
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(msg.id, { res, rej }));
}

async function main() {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: BASE });
  await sleep(7000);
  const out = await send("Runtime.evaluate", {
    expression: `(async function(){
      var r = await fetch('/@vite/client', { cache: 'no-store' });
      var t = await r.text();
      var m = t.match(/wsToken\\s*=\\s*"([^"]+)"/);
      var res = performance.getEntriesByType('resource').map(function(e){return e.name;}).filter(function(n){return n.indexOf('hmrGuard') >= 0;});
      return JSON.stringify({ status: r.status, tokenFromServer: m && m[1], hmrGuardRequests: res });
    })()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log("探测结果:", out?.result?.value ?? out);
}
main().catch((e) => console.error("FAIL", e)).finally(() => { try { child.kill(); } catch {} setTimeout(() => process.exit(0), 500); });
