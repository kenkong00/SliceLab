// 打开 SliceLab 素材库页并截图，验证缩略图能否正常显示
// 用法: node tools/shoot.mjs [url] [outFile]
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.argv[2] || "http://127.0.0.1:5180";
const OUT = process.argv[3] || "tools/screenshot.png";
const PORT = 9340;
const PROFILE = "F:\\TREA work\\window操作界面\\SliceLab\\.edge-shot";
try { mkdirSync(OUT.replace(/[^\\/]+$/, ""), { recursive: true }); } catch {}

const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu-sandbox", "--no-sandbox",
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--hide-scrollbars", "--disable-extensions", "--mute-audio",
  "--window-size=1600,1000", `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`, "about:blank",
], { stdio: "ignore" });

async function http(p) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return r.json(); }
let ws, id = 0; const pending = new Map();
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
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: BASE });
  await sleep(9000);

  const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

  // 点"素材库"页签（TabButton 内部可能是 span，不一定是 button）
  const clicked = await evaluate(`(function(){
    var els=[].slice.call(document.querySelectorAll('button,div,span,a,[role=tab]'));
    var t=els.filter(function(x){return (x.textContent||'').trim()==='素材库';})[0];
    if(!t) return 'no-el';
    t.click(); return 'ok:'+t.tagName;
  })()`);
  console.log('点击素材库:', clicked);
  await sleep(6000);
  await evaluate("window.scrollTo(0,0)");

  const stat = await evaluate(`(function(){
    var imgs=[].slice.call(document.querySelectorAll('img'));
    var lib=imgs.filter(function(i){return (i.getAttribute('src')||'').indexOf('/thumbnail')>=0;});
    var ok=lib.filter(function(i){return i.complete && i.naturalWidth>0;});
    return JSON.stringify({img总数:imgs.length, 缩略图数:lib.length, 已成功加载:ok.length, 前几个:lib.slice(0,3).map(function(i){return i.naturalWidth+'x'+i.naturalHeight;})});
  })()`);
  console.log('页面状态:', stat);

  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(OUT, Buffer.from(r.data, "base64"));
  console.log("已保存:", OUT);
}
main().catch((e) => console.error("FAIL", e)).finally(() => { try { child.kill(); } catch {} setTimeout(() => process.exit(0), 500); });
