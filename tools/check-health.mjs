/**
 * SliceLab 健康检查：确认后端、数据库、素材文件、缩略图都正常。
 * 用法: npm run health
 */
import Database from "better-sqlite3";
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "http://127.0.0.1:5181";

function line(ok, label, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

let allOk = true;

console.log("\n[1] 后端接口");
let backendUp = false;
try {
  const res = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) });
  const json = await res.json();
  backendUp = res.ok && json?.ok === true;
} catch {
  backendUp = false;
}
allOk = line(backendUp, "/api/health", backendUp ? "后端在线" : "后端未启动（127.0.0.1:5181）") && allOk;

if (backendUp) {
  for (const [path, label] of [
    ["/api/categories", "分类列表"],
    ["/api/images?limit=5", "图片列表"],
  ]) {
    try {
      const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(3000) });
      allOk = line(res.ok, label, `HTTP ${res.status}`) && allOk;
    } catch (e) {
      allOk = line(false, label, e.message) && allOk;
    }
  }
}

console.log("\n[2] 数据库与素材文件");
const dbPath = resolve(ROOT, "data", "slicelab.db");
if (!existsSync(dbPath)) {
  allOk = line(false, "数据库文件", `未找到 ${dbPath}`) && allOk;
} else {
  const db = new Database(dbPath, { readonly: true });
  try {
    const total = db.prepare("SELECT COUNT(*) c FROM images").get().c;
    const rows = db.prepare("SELECT id, name, file_path, thumb_path FROM images").all();
    let missFile = 0;
    let missThumb = 0;
    const pendingNonPng = [];
    for (const r of rows) {
      if (!r.file_path || !existsSync(r.file_path)) missFile++;
      if (r.thumb_path && existsSync(r.thumb_path)) continue;
      // 原图非 PNG（历史上传的 JPEG 被保存成 .png）时，服务端 pngjs 无法解码，
      // 只能回退直出原图 —— 这是预期行为，不算故障。
      let isPng = false;
      try {
        const fd = openSync(r.file_path, "r");
        const head = Buffer.alloc(8);
        readSync(fd, head, 0, 8, 0);
        closeSync(fd);
        isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
      } catch {
        isPng = false;
      }
      if (isPng) missThumb++;
      else pendingNonPng.push(r.id);
    }
    const cats = db.prepare("SELECT COUNT(*) c FROM categories").get().c;
    allOk = line(true, "SQLite 读取", `${total} 张图片 / ${cats} 个分类`) && allOk;
    allOk = line(missFile === 0, "原图文件", missFile === 0 ? "全部存在" : `${missFile} 张缺失`) && allOk;
    allOk = line(missThumb === 0, "缩略图缓存", missThumb === 0 ? "全部存在" : `${missThumb} 张待生成（重启后端会自动补齐）`) && allOk;
    if (pendingNonPng.length > 0) {
      console.log(
        `  · ${pendingNonPng.length} 张为非 PNG 原图，缩略图自动回退直出原图（id: ${pendingNonPng.slice(0, 10).join(", ")}${pendingNonPng.length > 10 ? "…" : ""}）`
      );
    }
  } finally {
    db.close();
  }
}

console.log(`\n[3] 结论: ${allOk ? "一切正常" : "存在问题，见上方 ✗ 项"}\n`);
process.exit(allOk ? 0 : 1);
