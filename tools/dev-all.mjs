/**
 * SliceLab 统一开发启动器
 *
 * 背景：直接用 concurrently 同时拉起后端和前端时，前端往往先就绪，
 * 而后端还在初始化（打开 SQLite、迁移 BLOB），此时前端所有 /api 请求
 * 都会 ECONNREFUSED，表现为满屏 500。
 *
 * 这里改成：先起后端 → 轮询 /api/health 直到成功 → 再起前端。
 * 日志带 [server]/[web] 前缀，退出时连同子进程树一起清理。
 *
 * 另外加了自愈：后端/前端若被外部 Ctrl+C、崩溃或意外退出，会自动重启
 * （窗口期内最多 N 次），不会像以前那样"后端一挂就把前端也带走"。
 *
 * 用法: node tools/dev-all.mjs
 */
import { spawn, execSync } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const API_ORIGIN = "http://127.0.0.1:5181";
const WEB_URL = "http://localhost:5180";
const HEALTH_TIMEOUT_MS = 60_000;

/**
 * 直接调用 node_modules 里的 CLI 入口，不走 npx。
 * 原因：npx 在本地找不到包时会去联网下载，离线/网络差时会一直卡住，
 * 而且多一层进程会让 Windows 下的 taskkill /T 杀不干净（残留占用端口）。
 * tools/ensure-env.mjs 已保证这些入口存在。
 */
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const VITE_CLI = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");

if (!existsSync(TSX_CLI) || !existsSync(VITE_CLI)) {
  console.error(
    "\n[dev] 本地 CLI 入口缺失（tsx / vite）。请先运行: node tools/ensure-env.mjs\n"
  );
  process.exit(1);
}

/** 自动重启策略：这个时间窗口内退出超过 MAX 次就放弃（避免崩溃死循环） */
const RESTART_WINDOW_MS = 120_000;
const MAX_RESTARTS = 5;

const isWin = process.platform === "win32";
/** @type {{name:string, cmd:string, color:string, child:import('node:child_process').ChildProcess, args:string[], exitTimes:number[]}[]} */
const procs = [];
let shuttingDown = false;

function launch(name, color, cmd, args) {
  const rec = {
    name,
    cmd,
    color,
    child: spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // 不能用 shell:true —— 项目路径里含空格(I:\TREA work\...)，
      // 走 shell 时整条命令会被 cmd 按空格切碎，报 "'I:\TREA' 不是内部或外部命令"。
      // 直接 CreateProcess 启动 node.exe 才能真正把参数安全传过去。
      shell: false,
      detached: isWin, // Windows 下需要进程组，才能连同子进程一起杀掉
      env: { ...process.env, FORCE_COLOR: "1" },
    }),
    args,
    exitTimes: [],
  };
  procs.push(rec);

  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, target) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) target.write(prefix + line + "\n");
    });
    stream.on("end", () => {
      if (buf) target.write(prefix + buf + "\n");
    });
  };
  pipe(rec.child.stdout, process.stdout);
  pipe(rec.child.stderr, process.stderr);

  rec.child.on("error", (err) => {
    console.error(`[${name}] 启动失败:`, err.message);
    console.error(`[${name}] 命令: ${cmd} ${args.join(" ")}`);
  });
  return rec;
}

/** 注册"意外退出自动重启" */
function watch(rec, color, onExit) {
  const { name, child } = rec;
  const startedAt = Date.now();
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    // 稳定运行超过窗口时长，说明之前那几次重启是偶发的，重置计数
    if (Date.now() - startedAt > RESTART_WINDOW_MS) rec.exitTimes.length = 0;
    rec.exitTimes.push(Date.now());
    const recent = rec.exitTimes.filter((t) => Date.now() - t < RESTART_WINDOW_MS).length;

    console.log(`\x1b[${color}m[${name}]\x1b[0m 进程退出 (code=${code} signal=${signal})`);

    if (code === 3221225786 || signal === "SIGINT") {
      // 0xC000013A = STATUS_CONTROL_C_EXIT，通常是外部 Ctrl+C / 终端被关掉
      console.log(`\x1b[${color}m[${name}]\x1b[0m 检测到被外部中断，准备自动重启…`);
    }

    if (recent > MAX_RESTARTS) {
      console.error(
        `\n[dev] ${name} 在 ${RESTART_WINDOW_MS / 1000}s 内退出 ${recent} 次，停止自动重启。请看上方 [${name}] 日志。\n`
      );
      onExit?.();
      shutdown(1);
      return;
    }

    const delay = Math.min(1500 * recent, 8000);
    console.log(`\x1b[${color}m[${name}]\x1b[0m ${delay}ms 后自动重启（第 ${recent} 次）…\n`);
    setTimeout(() => {
      if (shuttingDown) return;
      const idx = procs.indexOf(rec);
      // 用记录的 cmd/args 原样重启（早期版本用 args[0] 当命令，重启会失败）
      const fresh = launch(name, color, rec.cmd, rec.args);
      // 重启次数必须继承：否则每次重启都是全新计数，MAX_RESTARTS 永远触发不了，
      // 后端持续崩溃时会每 1.5s 无限重启刷屏，而不是停下来报错。
      fresh.exitTimes = rec.exitTimes;
      watch(fresh, color, onExit);
      if (idx >= 0) procs.splice(idx, 1);
      onExit?.(fresh);
    }, delay).unref?.();
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of procs) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (isWin && child.pid) {
        // /T 杀进程树，/F 强制；否则 npm/tsx 的子进程会残留占用端口
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 300);
}

async function waitForBackend() {
  const t0 = Date.now();
  let lastErr = "";
  while (Date.now() - t0 < HEALTH_TIMEOUT_MS) {
    try {
      const res = await fetch(`${API_ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e?.name === "TimeoutError" ? "连接超时" : (e?.message ?? String(e));
    }
    await sleep(500);
  }
  console.error(`\n[dev] 等待后端就绪超时（${HEALTH_TIMEOUT_MS / 1000}s）。最后一次错误：${lastErr}`);
  console.error("[dev] 常见原因：5181 端口被占用（上次进程没退干净），或 better-sqlite3 未正确安装。\n");
  return false;
}

/**
 * 端口是否已被占用。
 * 不能用 listen() 判断：Windows 上 Node 默认带 SO_REUSEADDR，
 * 即使端口已被占用 listen 也会成功，会误判成"空闲"（实测过，导致清理逻辑被跳过）。
 * 改用 connect 探测——能连上就说明确实有服务在监听。
 */
async function portBusy(port) {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(700);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

/**
 * 释放占用指定端口的残留进程。
 * 上次没退干净时，新进程会直接启动失败（vite 报 "Port 5180 is already in use"），
 * 这是"双击了却打不开"的常见次生原因。只清理 5180/5181 这两个本项目专用端口。
 */
function freePort(port) {
  if (!isWin) return 0;
  let freed = 0;
  try {
    const out = execSync("netstat -ano -p TCP", { encoding: "utf8", windowsHide: true });
    const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i");
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(re);
      if (m) pids.add(Number(m[1]));
    }
    for (const pid of pids) {
      if (pid === process.pid || pid === 0) continue;
      try {
        process.kill(pid, "SIGKILL"); // Windows 下等价于 TerminateProcess
        freed++;
      } catch {
        /* 已退出或无权限，忽略 */
      }
    }
  } catch {
    /* netstat 不可用时跳过，不影响启动 */
  }
  return freed;
}

async function main() {
  console.log("\n[dev] 启动 SliceLab：后端 5181 → 前端 5180\n");

  // 先清掉上次残留占用的端口，否则后端/vite 会直接启动失败
  for (const port of [5181, 5180]) {
    if (await portBusy(port)) {
      const n = freePort(port);
      console.log(
        n > 0
          ? `[dev] 端口 ${port} 被上次残留进程占用，已自动清理 ${n} 个进程`
          : `[dev] 警告：端口 ${port} 被占用且无法自动清理，可结束占用该端口的进程后重试`
      );
      await sleep(800);
    }
  }

  const server = launch("server", "35", process.execPath, [TSX_CLI, "watch", "server/index.ts"]);
  watch(server, "35");
  // 后端用 tsx watch，改 server/*.ts 会自行热重载，这里不需要额外处理

  const ok = await waitForBackend();
  if (!ok) {
    shutdown(1);
    return;
  }
  console.log("[dev] 后端已就绪，启动前端…\n");

  const web = launch("web", "36", process.execPath, [VITE_CLI]);
  watch(web, "36");

  // 前端起来后预热一次（失败不影响运行）
  setTimeout(() => {
    void fetch(WEB_URL).catch(() => undefined);
  }, 4000);

  console.log(`\n[dev] 前端: ${WEB_URL}    后端: ${API_ORIGIN}\n`);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(0));
}
process.on("uncaughtException", (e) => {
  console.error("[dev] 未捕获异常:", e);
  shutdown(1);
});

await main();
