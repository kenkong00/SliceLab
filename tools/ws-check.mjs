// 打开 SliceLab 首页，收集浏览器控制台消息，重点看 Vite HMR WebSocket 是否连上
// 用法: node tools/ws-check.mjs [url]
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.argv[2] || "http://localhost:5180";
const PORT = 9341;
const PROFILE = "F:\\TREA work\\window操作界面\\SliceLab\\.edge-wscheck";

const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu-sandbox", "--no-sandbox",
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--hide-scrollbars", "--disable-extensions", "--mute-audio",
  "--window-size=1400,900", `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`, "about:blank",
], { stdio: "ignore" });

async function http(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json(); }
let ws, id = 0; const pending = new Map();
const logs = [];
function send(method, params = {}) {
  const msg = { id: ++id, method, params };
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(msg.id, { res, rej }));
}

async function main() {
  for (let i = 0; i < 60; i++) { try { await http("/json/version"); break; } catch { await sleep(500); } }
  const targets = await http("/json/list");
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      logs.push(`[${m.params.type}] ${txt}`);
    }
    if (m.method === "Log.entryAdded") {
      const e = m.params.entry;
      logs.push(`[log:${e.level}] ${e.text} ${e.url || ""}`);
    }
    if (m.method === "Network.webSocketCreated") logs.push(`[ws:created] ${m.params.url}`);
    if (m.method === "Network.webSocketHandshakeResponseReceived") logs.push(`[ws:handshake] HTTP ${m.params.response.status}`);
    if (m.method === "Network.webSocketClosed") logs.push(`[ws:closed] ${m.params.url}`);
    if (m.method === "Network.webSocketFrameError") logs.push(`[ws:error] ${m.params.errorMessage}`);
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable");
  await send("Page.navigate", { url: BASE });
  await sleep(12000);

  const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  const token = await evaluate(`(function(){
    var s=[].slice.call(document.querySelectorAll('script'));
    return s.length + ' scripts; html len=' + document.documentElement.outerHTML.length;
  })()`);
  console.log("页面:", token);

  console.log("\n=== 控制台/网络消息（共 " + logs.length + " 条）===");
  const seen = new Set();
  for (const l of logs) {
    const key = l.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(l.slice(0, 200));
  }
  const wsFail = logs.filter((l) => l.includes("ws:error") || l.includes("ws:closed") || /websocket/i.test(l));
  console.log("\n结论:", wsFail.length === 0 ? "未发现 WebSocket 失败" : `发现 ${wsFail.length} 条 WS 相关消息（见上）`);
}
main().catch((e) => console.error("FAIL", e)).finally(() => { try { child.kill(); } catch {} setTimeout(() => process.exit(0), 500); });
