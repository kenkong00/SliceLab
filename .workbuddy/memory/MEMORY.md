# SliceLab 项目长期约定

## 启动链路
`start.bat` → `tools/ensure-env.mjs`（自检自愈）→ `tools/dev-all.mjs`（后端 5181 → 前端 5180）

- **Node 运行时固定用 `runtime/node/node.exe`（v22.22.2 / ABI 127）**，start.bat 优先它，
  找不到才回退系统 node。这是为了避免 better-sqlite3 的 ABI 随系统 Node 漂移。
  换电脑迁移 = 整个文件夹（含 runtime/ + node_modules/ + data/）一起拷，双击即跑。

## 踩过的坑（务必遵守）
1. **判断 better-sqlite3 是否可用，不能 `require('better-sqlite3')`** —— 它只在
   `new Database()` 时才 dlopen，require 永远成功，会漏掉 ABI 不匹配。
   必须 `process.dlopen({exports:{}}, '<...>/build/Release/better_sqlite3.node')` 实测。
2. **路径含空格（`I:\TREA work\...`），child_process 一律 `shell:false`**。
   走 shell 时命令行被 cmd 按空格切碎 → `'I:\TREA' 不是内部或外部命令`。
   只有 `.cmd`/`.bat` 才允许 shell:true。
3. **跑 npm 必须和启动用的 node 同源**（`process.execPath + npm-cli.js`）。
   prebuild-install 按运行它的 node 的 ABI 挑预编译包；用系统 npm 会装错版本。
4. **重建 better-sqlite3 前要先删掉旧二进制**，否则 prebuild-install 以为已装好直接跳过。
5. **原生模块下载源**：官方 GitHub Releases 在国内常卡 5min+；
   `npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3`
   实测 6 秒完成。ensure-env 里已内置「官方超时 90s → 自动切镜像」。
6. **`.bat` 必须 GBK/ASCII + CRLF，不要写 `chcp 65001`**（转换：`sed 's/$/\r/'`）。
   bat 内容保持纯 ASCII 英文，中文交给 .mjs 输出（Node 走 WriteConsoleW，GBK 控制台正常）。

## 路径可移植（项目放在移动硬盘上，盘符随时会变）
1. **数据库里绝不能存绝对路径** —— 移动硬盘在不同电脑上盘符会变（已实测 F: → I:），
   存绝对路径会导致换电脑后所有素材读不出来（`existsSync` 全 false，图片全丢）。
2. **统一约定**：入库用 `toStoredPath()` 转相对项目根（如 `data/library/x.png`），
   读取用 `resolveStoredPath()` 按**当前**项目根解析；对旧盘符的绝对路径，
   按 `data/library/` 标记截取后半段再挂到当前根目录 —— 无需知道旧盘符是什么。
3. `db.ts` 模块加载时自动跑 `normalizeStoredPaths()`，把历史绝对路径改写为相对路径，
   跑一次即永久生效（SQL 只挑 `substr(file_path,2,1)=':'` 的行，不全表扫）。
4. **判断端口占用不能用 `listen()`** —— Windows 下 Node 默认带 SO_REUSEADDR，
   端口被占时 listen 照样成功，会误判成空闲（实测踩到）。用 `connect()` 探测才准。

## 不要退回的写法
- 不要用 `npx tsx` / `npx vite` 拉起服务：离线会卡死，且多一层进程导致 taskkill /T 杀不干净、
  端口残留。直接 `node node_modules/tsx/dist/cli.mjs`、`node node_modules/vite/bin/vite.js`。
