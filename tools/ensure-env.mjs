/**
 * SliceLab 环境自检与自愈 (tools/ensure-env.mjs)
 *
 * 背景：这个项目在"换一台电脑 / 换一个 Node 版本"时几乎必然起不来，主要有四个坑：
 *   1. node_modules 缺失 -> 需要 npm install。
 *   2. better-sqlite3 是原生模块，二进制与 Node 的 ABI (NODE_MODULE_VERSION) 强绑定。
 *      在 A 电脑上用 Node 22 (ABI 127) 装的二进制，拿到 B 电脑的 Node 24 (ABI 137)
 *      上加载会直接 ERR_DLOPEN_FAILED，后端一启动就崩，前端等健康检查 60s 后超时退出。
 *      这是本项目"换个环境就跑不起来"的头号原因。
 *   3. 用 npx 拉起 tsx/vite，本地找不到时会联网下载，离线或网络差时直接卡死。
 *   4. 原生模块的预编译包默认托管在 GitHub Releases，国内网络常常几分钟拉不下来。
 *
 * 本脚本在启动前把这些全部检查并自动修好，让 start.bat 在任何一台有 Node 的机器上
 * 都能"双击即跑"，不需要人工敲命令。
 *
 * 用法: node tools/ensure-env.mjs
 * 退出码: 0 = 环境就绪; 非 0 = 无法自动修复（会打印明确原因）
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const NPM = IS_WIN ? "npm.cmd" : "npm";

/** 本地 CLI 入口（绕过 npx，保证离线可启动） */
const ENTRIES = [
  ["tsx", path.join("node_modules", "tsx", "dist", "cli.mjs")],
  ["vite", path.join("node_modules", "vite", "bin", "vite.js")],
];
const NATIVE_REL = path.join(
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node"
);
const NATIVE = path.join(ROOT, NATIVE_REL);

/** 原生模块下载源：官方源在国内常常卡死，超时后自动切国内镜像 */
const SOURCES = [
  { name: "official (GitHub Releases)", mirror: null, timeout: 90_000 },
  {
    name: "npmmirror",
    mirror: "https://registry.npmmirror.com/-/binary/better-sqlite3",
    timeout: 180_000,
  },
];

const C = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
};

const log = (m) => console.log(m);
const step = (m) => console.log(C.g("[env] ") + m);

/** @param {{silent?:boolean, timeout?:number, env?:Record<string,string>}} opts */
function run(cmd, args, opts = {}) {
  const { silent = false, timeout = 0, env = {} } = opts;
  // .cmd/.bat 必须经 shell 才能执行；而 node.exe 这类可执行文件绝不能走 shell，
  // 否则含空格的路径(I:\TREA work\...)会被 cmd 切成多段，
  // 报 "'I:\TREA' 不是内部或外部命令"。
  const needsShell = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
  const finalArgs = needsShell
    ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a))
    : args;

  const r = spawnSync(cmd, finalArgs, {
    cwd: ROOT,
    stdio: silent ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: needsShell,
    timeout: timeout || undefined,
    env: { ...process.env, npm_config_foreground_scripts: "1", ...env },
  });

  if (r.error) {
    if (r.error.code === "ETIMEDOUT") {
      log(C.d(`       (timeout after ${Math.round(timeout / 1000)}s)`));
    } else if (silent) {
      log(C.d(`       ${r.error.message}`));
    }
    return false;
  }
  if (r.status !== 0 && silent) {
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (out) log(C.d(out.split(/\r?\n/).slice(-10).join("\n")));
  }
  return r.status === 0;
}

/**
 * 用「与启动 Node 同源」的 npm 执行命令。
 * 这点很关键：prebuild-install 是按运行它的那个 node 的 ABI 去挑预编译包的。
 * 若 npm 跑在系统 Node 24 上（装出 ABI 137 的二进制），而项目实际用 runtime 的
 * Node 22 (ABI 127) 启动，一样会 dlopen 失败 —— 而且极难排查。
 */
function resolveNpm() {
  const exeDir = path.dirname(process.execPath);
  const npmCli = [
    path.join(exeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(exeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((p) => existsSync(p));
  return npmCli ? [process.execPath, [npmCli]] : [NPM, []];
}

function runNpm(npmArgs, opts = {}) {
  const [cmd, base] = resolveNpm();
  const env = opts.mirror
    ? { npm_config_better_sqlite3_binary_host_mirror: opts.mirror }
    : {};
  return run(cmd, [...base, ...npmArgs], { ...opts, env });
}

/**
 * 实测原生模块能否被当前 Node 加载。
 * 注意：不能用 require('better-sqlite3') 判断——它只在 new Database() 时才 dlopen，
 * require 永远成功，会漏掉 ABI 不匹配。这里直接 dlopen 二进制本体。
 */
function nativeOk() {
  if (!existsSync(NATIVE)) return { ok: false, reason: "binary-missing" };
  const probe = `
    try { process.dlopen({ exports: {} }, process.argv[1]); process.exit(0); }
    catch (e) { console.error(e.message); process.exit(1); }
  `;
  const r = spawnSync(process.execPath, ["-e", probe, NATIVE], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status === 0) return { ok: true };
  const msg = `${r.stderr ?? ""}`;
  return {
    ok: false,
    reason: "abi-mismatch",
    builtFor: msg.match(/using\s+NODE_MODULE_VERSION\s+(\d+)/i)?.[1],
    needFor: msg.match(/requires\s+NODE_MODULE_VERSION\s+(\d+)/i)?.[1],
  };
}

const missingEntries = () =>
  ENTRIES.filter(([, rel]) => !existsSync(path.join(ROOT, rel))).map(([n]) => n);

function installDeps(mirror) {
  step("安装依赖 npm install（首次运行会自动执行，需联网）…");
  return runNpm(["install", "--no-audit", "--no-fund"], {
    silent: true,
    timeout: 600_000,
    mirror,
  });
}

/**
 * 修 better-sqlite3 原生模块：
 * 优先取官方/镜像预编译包（不需要 VS 生成工具），逐个来源尝试，超时就换下一个。
 */
function repairNative(info) {
  if (info.reason === "abi-mismatch") {
    step(
      C.y(
        `better-sqlite3 二进制 ABI 不匹配：现有 ${info.builtFor}，当前 Node(${process.version}) 需要 ${info.needFor}`
      )
    );
  } else {
    step(C.y("better-sqlite3 原生二进制缺失"));
  }
  step("自动修复中，无需手工操作…");

  // 删掉不匹配的二进制，否则 prebuild-install 会以为已经装好而直接跳过
  if (existsSync(NATIVE)) rmSync(NATIVE, { force: true });

  for (const src of SOURCES) {
    step(`尝试下载源：${C.d(src.name)}`);
    if (
      runNpm(["rebuild", "better-sqlite3", "--foreground-scripts"], {
        silent: true,
        timeout: src.timeout,
        mirror: src.mirror ?? undefined,
      }) &&
      nativeOk().ok
    ) {
      return true;
    }
  }

  log(C.d("-> 预编译都失败了，改为从 npmmirror 重新安装 better-sqlite3"));
  if (
    runNpm(["install", "better-sqlite3", "--force", "--no-audit", "--no-fund"], {
      silent: true,
      timeout: 300_000,
      mirror: SOURCES[1].mirror,
    }) &&
    nativeOk().ok
  ) {
    return true;
  }

  return false;
}

function main() {
  log(
    C.d(`[env] project: ${ROOT}`) +
      `\n[env] Node ${process.version}  ABI ${process.versions.modules}  (${process.platform}/${process.arch})`
  );

  // 1) 依赖完整性
  if (!existsSync(path.join(ROOT, "node_modules"))) {
    if (!installDeps(SOURCES[1].mirror)) {
      console.error(
        C.r("\n[env] npm install 失败。请检查网络，或手动执行 npm install 看完整输出。\n")
      );
      return 1;
    }
  }

  if (missingEntries().length) {
    step(`缺少本地 CLI 入口: ${missingEntries().join(", ")}，补装依赖…`);
    if (!installDeps(SOURCES[1].mirror)) {
      console.error(C.r("\n[env] 依赖补装失败，无法启动。\n"));
      return 1;
    }
  }
  if (missingEntries().length) {
    console.error(C.r(`\n[env] 以下入口仍然缺失: ${missingEntries().join(", ")}\n`));
    return 1;
  }

  // 2) 原生模块 ABI
  const info = nativeOk();
  if (!info.ok && !repairNative(info)) {
    console.error(
      C.r("\n[env] could not repair better-sqlite3 automatically.\n") +
        C.d(
          "      Likely causes: offline, or no C++ build toolchain.\n" +
            "      Options:\n" +
            "        a) reconnect network and run start.bat again\n" +
            "        b) install C++ build tools:  npm i -g windows-build-tools\n" +
            `        c) use the Node version that matches the existing binary (ABI ${info.builtFor ?? "?"})\n`
        )
    );
    return 1;
  }
  if (!info.ok) step(C.g("better-sqlite3 repaired"));

  // 3) 数据目录
  const dataDir = path.join(ROOT, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  log(C.g("[env] 环境检查通过，开始启动…"));
  return 0;
}

process.exit(main());
