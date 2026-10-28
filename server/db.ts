import Database from "better-sqlite3";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  renameSync,
} from "node:fs";
import { dirname, resolve, join, extname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * 项目根目录。这个项目放在移动硬盘上，插到不同电脑上盘符会变（F: / I: / J: …），
 * 所以数据库里绝不能存绝对路径 —— 盘符一变所有图片都会读不出来。
 * 统一以「相对项目根目录」的形式存库，运行时再按当前的 PROJECT_ROOT 解析。
 */
const PROJECT_ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(PROJECT_ROOT, "data");
mkdirSync(DATA_DIR, { recursive: true });

// 素材文件存储目录：data/library/，缩略图目录：data/library/.thumbs/
export const STORAGE_DIR = resolve(DATA_DIR, "library");
export const THUMBS_DIR = resolve(STORAGE_DIR, ".thumbs");
mkdirSync(STORAGE_DIR, { recursive: true });
mkdirSync(THUMBS_DIR, { recursive: true });

const DB_PATH = resolve(DATA_DIR, "slicelab.db");

/** 缩略图最长边（px）。素材库网格展示用，兼顾清晰度与体积。 */
export const THUMB_MAX = 320;

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ============ Schema ============
db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  pixel_count INTEGER DEFAULT 0,
  data BLOB,
  thumbnail BLOB,
  file_path TEXT,
  thumb_path TEXT,
  source_file TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_images_category ON images(category_id);
CREATE INDEX IF NOT EXISTS idx_images_name ON images(name);
`);

// ============ Schema 迁移：为旧库添加新列 ============
try {
  const cols = db.pragma("table_info(images)") as { name: string; notnull: number }[];
  const hasFilePath = cols.some((c) => c.name === "file_path");
  const hasThumbPath = cols.some((c) => c.name === "thumb_path");
  if (!hasFilePath) db.exec("ALTER TABLE images ADD COLUMN file_path TEXT");
  if (!hasThumbPath) db.exec("ALTER TABLE images ADD COLUMN thumb_path TEXT");

  // 旧库的 data/thumbnail 列可能是 NOT NULL，导致迁移时无法置 NULL。
  // 通过重建表把这两列改为可空（SQLite 不支持 ALTER COLUMN）。
  const dataCol = cols.find((c) => c.name === "data");
  const thumbCol = cols.find((c) => c.name === "thumbnail");
  if ((dataCol && dataCol.notnull === 1) || (thumbCol && thumbCol.notnull === 1)) {
    console.log("[db] rebuilding images table to relax NOT NULL on data/thumbnail...");
    db.exec(`
CREATE TABLE images_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  pixel_count INTEGER DEFAULT 0,
  data BLOB,
  thumbnail BLOB,
  file_path TEXT,
  thumb_path TEXT,
  source_file TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);
INSERT INTO images_new (id, name, category_id, width, height, pixel_count, data, thumbnail, file_path, thumb_path, source_file, metadata, created_at, updated_at)
SELECT id, name, category_id, width, height, pixel_count, data, thumbnail, file_path, thumb_path, source_file, metadata, created_at, updated_at FROM images;
DROP TABLE images;
ALTER TABLE images_new RENAME TO images;
CREATE INDEX IF NOT EXISTS idx_images_category ON images(category_id);
CREATE INDEX IF NOT EXISTS idx_images_name ON images(name);
`);
    console.log("[db] images table rebuilt.");
  }
} catch (e) {
  console.error("[db] schema migration failed:", e);
}

// ============ 文件存储辅助函数 ============
/** 将任意名称转为安全的文件名片段（去掉路径分隔符等危险字符） */
export function safeFileName(name: string): string {
  // 去掉扩展名（统一存 png），去掉路径分隔符和控制字符
  const base = name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  return base || "image";
}

/** 生成素材原图的硬盘路径：data/library/<safeName>__<id>.png */
export function imageFilePath(id: number, name: string): string {
  return join(STORAGE_DIR, `${safeFileName(name)}__${id}.png`);
}

/** 生成素材缩略图的硬盘路径：data/library/.thumbs/<id>.png */
export function imageThumbPath(id: number): string {
  return join(THUMBS_DIR, `${id}.png`);
}

// ============ 可移植路径：入库存相对路径，读取时按当前项目根解析 ============
/** 素材库在项目中固定位置的相对前缀，用于从任意盘符的绝对路径里还原相对路径 */
const LIBRARY_MARKER = "data/library/";

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** 磁盘绝对路径 -> 入库形式（相对项目根，统一 / 分隔）。跨盘符也能正确还原。 */
export function toStoredPath(abs: string): string {
  const norm = toPosix(abs);
  const idx = norm.toLowerCase().lastIndexOf(LIBRARY_MARKER);
  if (idx >= 0) return norm.slice(idx);
  return toPosix(relative(PROJECT_ROOT, abs));
}

/**
 * 入库路径 -> 当前机器上的真实绝对路径。
 * 兼容三种历史数据：
 *   ① 相对路径（新格式，与盘符无关）
 *   ② 当前盘符的绝对路径
 *   ③ 旧盘符的绝对路径（如 F:\...，换电脑/换盘符后最常见的情况）
 */
export function resolveStoredPath(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (isAbsolute(stored)) {
    if (existsSync(stored)) return stored; // ②
    // ③ 盘符已变：取 data/library/ 之后的部分，重新挂到当前项目根
    const norm = toPosix(stored);
    const idx = norm.toLowerCase().lastIndexOf(LIBRARY_MARKER);
    if (idx >= 0) return resolve(PROJECT_ROOT, norm.slice(idx));
    return stored;
  }
  return resolve(PROJECT_ROOT, stored); // ①
}

/**
 * 启动时把库里残留的绝对路径一次性改写为相对路径。
 * 跑过一次后就永久与盘符无关，下次换电脑不再需要修。
 */
export function normalizeStoredPaths(): number {
  let changed = 0;
  try {
    // 只挑出仍是绝对路径的行（Windows 绝对路径第 2 个字符是冒号），避免全表改写
    const rows = db
      .prepare(
        `SELECT id, file_path, thumb_path FROM images
         WHERE (file_path IS NOT NULL AND substr(file_path, 2, 1) = ':')
            OR (thumb_path IS NOT NULL AND substr(thumb_path, 2, 1) = ':')`
      )
      .all() as { id: number; file_path: string | null; thumb_path: string | null }[];
    const upd = db.prepare(`UPDATE images SET file_path = ?, thumb_path = ? WHERE id = ?`);
    const tx = db.transaction((items: typeof rows) => {
      for (const r of items) {
        const fp =
          r.file_path && isAbsolute(r.file_path) ? toStoredPath(r.file_path) : r.file_path;
        const tp =
          r.thumb_path && isAbsolute(r.thumb_path) ? toStoredPath(r.thumb_path) : r.thumb_path;
        if (fp !== r.file_path || tp !== r.thumb_path) {
          upd.run(fp, tp, r.id);
          changed++;
        }
      }
    });
    tx(rows);
    if (changed > 0) {
      console.log(
        `[db] 已将 ${changed} 条记录的绝对路径改为相对路径（此后换电脑/换盘符不再失效）。`
      );
    }
  } catch (e) {
    console.error("[db] 路径归一化失败:", e);
  }
  return changed;
}

/** 启动时迁移：把已有 BLOB 写到硬盘，更新 file_path/thumb_path，清空 BLOB */
export function migrateBlobsToDisk(): { migrated: number } {
  const rows = db
    .prepare(`SELECT id, name, data, thumbnail FROM images WHERE file_path IS NULL AND data IS NOT NULL`)
    .all() as { id: number; name: string; data: Buffer; thumbnail: Buffer | null }[];
  let migrated = 0;
  for (const r of rows) {
    try {
      const fp = imageFilePath(r.id, r.name);
      writeFileSync(fp, r.data);
      let tp: string | null = null;
      if (r.thumbnail && r.thumbnail.length > 0) {
        tp = imageThumbPath(r.id);
        writeFileSync(tp, r.thumbnail);
      }
      db.prepare(
        `UPDATE images SET file_path = ?, thumb_path = ?, data = NULL, thumbnail = NULL WHERE id = ?`
      ).run(toStoredPath(fp), tp ? toStoredPath(tp) : null, r.id);
      migrated++;
    } catch (e) {
      console.error(`[migrate] image ${r.id} failed:`, e);
    }
  }
  if (migrated > 0) {
    console.log(`[db] migrated ${migrated} BLOB(s) to disk storage.`);
    // 回收 BLOB 清空后遗留的空闲页，并截断 WAL
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      console.log("[db] VACUUM completed to reclaim disk space.");
    } catch (e) {
      console.error("[db] VACUUM failed:", e);
    }
  }
  return { migrated };
}

// ============ Types ============
export interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
  created_at: string;
}

export interface ImageRow {
  id: number;
  name: string;
  category_id: number | null;
  width: number;
  height: number;
  pixel_count: number;
  data: Buffer | null;
  thumbnail: Buffer | null;
  file_path: string | null;
  thumb_path: string | null;
  source_file: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImageMeta {
  id: number;
  name: string;
  category_id: number | null;
  width: number;
  height: number;
  pixel_count: number;
  source_file: string | null;
  metadata: any;
  created_at: string;
  updated_at: string;
}

/** 安全解析 metadata：历史脏数据（非法 JSON）不应让整个列表接口 500 */
function safeParseMeta(raw: string | null): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ============ Categories ============
export function listCategories(): CategoryRow[] {
  return db
    .prepare(`SELECT * FROM categories ORDER BY sort_order ASC, id ASC`)
    .all() as CategoryRow[];
}

export function createCategory(name: string, parentId: number | null): CategoryRow {
  const stmt = db.prepare(
    `INSERT INTO categories (name, parent_id) VALUES (?, ?)`
  );
  const info = stmt.run(name, parentId);
  return getCategory(info.lastInsertRowid as number)!;
}

export function getCategory(id: number): CategoryRow | undefined {
  return db
    .prepare(`SELECT * FROM categories WHERE id = ?`)
    .get(id) as CategoryRow | undefined;
}

export function renameCategory(id: number, name: string): void {
  db.prepare(`UPDATE categories SET name = ? WHERE id = ?`).run(name, id);
}

export function moveCategory(id: number, parentId: number | null): void {
  // 防止把分类移动到自己或其后代下面
  if (parentId !== null) {
    if (parentId === id) throw new Error("不能将分类移动到自身下");
    let cur: number | null = parentId;
    while (cur !== null) {
      const row = getCategory(cur);
      if (!row) break;
      if (row.parent_id === id) throw new Error("不能将分类移动到其子分类下");
      cur = row.parent_id;
    }
  }
  db.prepare(`UPDATE categories SET parent_id = ? WHERE id = ?`).run(parentId, id);
}

export function deleteCategory(id: number): void {
  // 子分类被 CASCADE 删除，图片的 category_id 被 SET NULL
  db.prepare(`DELETE FROM categories WHERE id = ?`).run(id);
}

// ============ Images ============
export function listImages(opts: {
  categoryId?: number | null;
  search?: string;
  limit?: number;
  offset?: number;
}): { items: ImageMeta[]; total: number } {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.categoryId !== undefined) {
    where.push(`category_id ${opts.categoryId === null ? "IS NULL" : "= ?"}`);
    if (opts.categoryId !== null) params.push(opts.categoryId);
  }
  if (opts.search) {
    // 配合调用方对 % _ \ 的转义
    where.push(`name LIKE ? ESCAPE '\\'`);
    params.push(`%${opts.search}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // 钳制分页参数，避免超大 limit / 负数 offset 拖垮服务
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100) || 100, 1), 500);
  const offset = Math.max(Math.floor(opts.offset ?? 0) || 0, 0);

  const total = (
    db.prepare(`SELECT COUNT(*) as c FROM images ${whereSql}`).get(...params) as {
      c: number;
    }
  ).c;

  const rows = db
    .prepare(
      `SELECT id, name, category_id, width, height, pixel_count, source_file, metadata, created_at, updated_at
       FROM images ${whereSql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as any[];

  const items: ImageMeta[] = rows.map((r) => ({
    ...r,
    metadata: safeParseMeta(r.metadata),
  }));
  return { items, total };
}

export function listImagesByIds(ids: number[]): ImageMeta[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, name, category_id, width, height, pixel_count, source_file, metadata, created_at, updated_at
       FROM images WHERE id IN (${placeholders})`
    )
    .all(...ids) as any[];
  return rows.map((r) => ({
    ...r,
    metadata: safeParseMeta(r.metadata),
  }));
}

export function getImageMeta(id: number): ImageMeta | undefined {
  const row = db
    .prepare(
      `SELECT id, name, category_id, width, height, pixel_count, source_file, metadata, created_at, updated_at
       FROM images WHERE id = ?`
    )
    .get(id) as any;
  if (!row) return undefined;
  return { ...row, metadata: safeParseMeta(row.metadata) };
}

/**
 * 读取图片 PNG bytes：优先从硬盘 file_path 读取，回退读 BLOB（兼容未迁移的数据）
 */
export function getImageData(id: number): ImageRow | undefined {
  return db.prepare(`SELECT * FROM images WHERE id = ?`).get(id) as
    | ImageRow
    | undefined;
}

/** 读取图片 PNG bytes（从硬盘或 BLOB） */
export function readImagePng(id: number): Buffer | null {
  const row = getImageData(id);
  if (!row) return null;
  const fp = resolveStoredPath(row.file_path);
  if (fp && existsSync(fp)) {
    return readFileSync(fp);
  }
  return row.data ?? null;
}

// ============ 缩略图 ============
/**
 * 区域平均降采样（比最近邻更平滑，避免缩略图出现摩尔纹/锯齿）。
 * 输入输出均为 PNG bytes；非 PNG 或解码失败时返回 null。
 */
function downscalePng(buf: Buffer, maxSize: number): Buffer | null {
  try {
    const png = PNG.sync.read(buf);
    const { width, height } = png;
    if (width === 0 || height === 0) return null;
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const out = new PNG({ width: tw, height: th });
    const xRatio = width / tw;
    const yRatio = height / th;
    for (let y = 0; y < th; y++) {
      const sy0 = Math.floor(y * yRatio);
      const sy1 = Math.min(height, Math.max(sy0 + 1, Math.floor((y + 1) * yRatio)));
      for (let x = 0; x < tw; x++) {
        const sx0 = Math.floor(x * xRatio);
        const sx1 = Math.min(width, Math.max(sx0 + 1, Math.floor((x + 1) * xRatio)));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            const si = (sy * width + sx) * 4;
            const alpha = png.data[si + 3];
            // 预乘 alpha 后平均，避免透明像素污染 RGB
            r += png.data[si] * alpha;
            g += png.data[si + 1] * alpha;
            b += png.data[si + 2] * alpha;
            a += alpha;
            n++;
          }
        }
        if (n === 0) continue;
        const di = (y * tw + x) * 4;
        if (a > 0) {
          out.data[di] = Math.round(r / a);
          out.data[di + 1] = Math.round(g / a);
          out.data[di + 2] = Math.round(b / a);
          out.data[di + 3] = Math.round(a / n);
        } else {
          out.data[di] = 0;
          out.data[di + 1] = 0;
          out.data[di + 2] = 0;
          out.data[di + 3] = 0;
        }
      }
    }
    return PNG.sync.write(out, { deflateLevel: 6 });
  } catch {
    // 非 PNG（例如历史上传的 JPEG 被保存成 .png）会在此失败，交给调用方回退
    return null;
  }
}

/** 生成失败过的 id，避免每次请求都重跑昂贵的解码 */
const thumbFailed = new Set<number>();

/**
 * 确保缩略图存在：缺失则即时生成、写盘并把路径回写数据库。
 * 返回缩略图 bytes；无法生成时返回 null（调用方应回退到原图）。
 */
export function ensureThumbnail(id: number): Buffer | null {
  const row = getImageData(id);
  if (!row) return null;

  // 1) 已生成且文件仍在
  const tp0 = resolveStoredPath(row.thumb_path);
  if (tp0 && existsSync(tp0)) {
    try {
      return readFileSync(tp0);
    } catch {
      /* 文件损坏则继续走重新生成 */
    }
  }
  if (thumbFailed.has(id)) return null;

  // 2) 用原图生成
  const fp0 = resolveStoredPath(row.file_path);
  const src = fp0 && existsSync(fp0) ? readFileSync(fp0) : row.data;
  if (!src || src.length === 0) return null;
  const thumb = downscalePng(src, THUMB_MAX);
  if (!thumb) {
    thumbFailed.add(id);
    return null;
  }

  // 3) 落盘并回写路径
  const tp = imageThumbPath(id);
  try {
    writeFileSync(tp, thumb);
    db.prepare(`UPDATE images SET thumb_path = ? WHERE id = ?`).run(toStoredPath(tp), id);
  } catch (e) {
    console.error(`[thumb] persist failed for image ${id}:`, e);
  }
  return thumb;
}

/** 列出缩略图缺失（或文件已丢失）的图片 id */
export function listImageIdsMissingThumb(): number[] {
  const rows = db
    .prepare(`SELECT id, thumb_path, file_path FROM images ORDER BY id DESC`)
    .all() as { id: number; thumb_path: string | null; file_path: string | null }[];
  return rows
    .filter((r) => {
      if (thumbFailed.has(r.id)) return false;
      const tp = resolveStoredPath(r.thumb_path);
      const fp = resolveStoredPath(r.file_path);
      return (!tp || !existsSync(tp)) && (fp ? existsSync(fp) : true);
    })
    .map((r) => r.id);
}

/**
 * 为单张图补齐缩略图（供启动后的后台预热调用，逐张让出事件循环）。
 */
export function buildThumbnail(id: number): boolean {
  try {
    return ensureThumbnail(id) !== null;
  } catch (e) {
    console.error(`[thumb] build failed for image ${id}:`, e);
    thumbFailed.add(id);
    return false;
  }
}

/** 读取缩略图 PNG bytes：缺失时即时生成并缓存，实在生成不了才回退原图 */
export function readImageThumb(id: number): Buffer | null {
  try {
    const t = ensureThumbnail(id);
    if (t) return t;
  } catch (e) {
    console.error(`[thumb] ensure failed for image ${id}:`, e);
  }
  return readImagePng(id);
}

/**
 * 落盘原图 + 缩略图，返回磁盘路径。
 * 缩略图未显式提供时自动用原图生成，保证新导入的素材立即有缩略图可用。
 */
function writeImageFiles(
  id: number,
  name: string,
  data: Buffer,
  thumbnail?: Buffer | null
): { fp: string; tp: string | null } {
  const fp = imageFilePath(id, name);
  writeFileSync(fp, data);

  let thumbBuf = thumbnail && thumbnail.length > 0 ? thumbnail : downscalePng(data, THUMB_MAX);
  if (!thumbBuf) {
    thumbFailed.add(id);
    return { fp, tp: null };
  }
  const tp = imageThumbPath(id);
  try {
    writeFileSync(tp, thumbBuf);
  } catch (e) {
    console.error(`[thumb] write failed for image ${id}:`, e);
    thumbFailed.add(id);
    return { fp, tp: null };
  }
  return { fp, tp };
}

export interface CreateImageInput {
  name: string;
  category_id?: number | null;
  width: number;
  height: number;
  pixel_count?: number;
  data: Buffer; // PNG bytes
  thumbnail?: Buffer | null;
  source_file?: string | null;
  metadata?: any;
}

export function createImage(input: CreateImageInput): number {
  // 先插入得到 id，再写盘，再更新路径
  const stmt = db.prepare(
    `INSERT INTO images (name, category_id, width, height, pixel_count, data, thumbnail, source_file, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    input.name,
    input.category_id ?? null,
    input.width,
    input.height,
    input.pixel_count ?? 0,
    input.data,
    input.thumbnail ?? null,
    input.source_file ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null
  );
  const id = info.lastInsertRowid as number;
  // 写入硬盘（原图 + 缩略图），并清空 BLOB
  const { fp, tp } = writeImageFiles(id, input.name, input.data, input.thumbnail);
  db.prepare(
    `UPDATE images SET file_path = ?, thumb_path = ?, data = NULL, thumbnail = NULL WHERE id = ?`
  ).run(toStoredPath(fp), tp ? toStoredPath(tp) : null, id);
  return id;
}

export function createImagesBatch(inputs: CreateImageInput[]): number[] {
  const insertStmt = db.prepare(
    `INSERT INTO images (name, category_id, width, height, pixel_count, data, thumbnail, source_file, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateStmt = db.prepare(
    `UPDATE images SET file_path = ?, thumb_path = ?, data = NULL, thumbnail = NULL WHERE id = ?`
  );
  const ids: number[] = [];
  const tx = db.transaction((items: CreateImageInput[]) => {
    for (const input of items) {
      const info = insertStmt.run(
        input.name,
        input.category_id ?? null,
        input.width,
        input.height,
        input.pixel_count ?? 0,
        input.data,
        input.thumbnail ?? null,
        input.source_file ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null
      );
      const id = info.lastInsertRowid as number;
      ids.push(id);
    }
  });
  tx(inputs);
  // 事务提交后写盘（避免事务过大）
  for (let i = 0; i < inputs.length; i++) {
    const id = ids[i];
    const input = inputs[i];
    const { fp, tp } = writeImageFiles(id, input.name, input.data, input.thumbnail);
    updateStmt.run(toStoredPath(fp), tp ? toStoredPath(tp) : null, id);
  }
  return ids;
}

export function renameImage(id: number, name: string): void {
  // 同步重命名硬盘文件
  const row = getImageData(id);
  const fp = resolveStoredPath(row?.file_path);
  if (fp && existsSync(fp)) {
    const newFp = imageFilePath(id, name);
    if (newFp !== fp) {
      try {
        renameSync(fp, newFp);
      } catch (e) {
        console.error(`[rename] image ${id} file rename failed:`, e);
      }
      db.prepare(
        `UPDATE images SET name = ?, file_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(name, toStoredPath(newFp), id);
      return;
    }
  }
  db.prepare(
    `UPDATE images SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(name, id);
}

/**
 * 批量改名：按 ids 顺序依次命名为 <prefix><index>（index 从 1 开始）
 */
export function batchRenameImages(ids: number[], prefix: string): void {
  const stmt = db.prepare(
    `UPDATE images SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  );
  const tx = db.transaction(() => {
    ids.forEach((id, idx) => {
      const newName = `${prefix}${idx + 1}`;
      // 同步重命名硬盘文件
      const row = getImageData(id);
      const fp = resolveStoredPath(row?.file_path);
      if (fp && existsSync(fp)) {
        const newFp = imageFilePath(id, newName);
        if (newFp !== fp) {
          try {
            renameSync(fp, newFp);
            stmt.run(newName, id);
            db.prepare(
              `UPDATE images SET file_path = ? WHERE id = ?`
            ).run(toStoredPath(newFp), id);
            return;
          } catch (e) {
            console.error(`[batch-rename] image ${id} file rename failed:`, e);
          }
        }
      }
      stmt.run(newName, id);
    });
  });
  tx();
}

/** 替换图片数据（PNG bytes）、尺寸、缩略图 */
export function updateImageData(
  id: number,
  input: { data: Buffer; width: number; height: number; thumbnail?: Buffer | null }
): void {
  // 写入硬盘
  const row = getImageData(id);
  const storedFp = resolveStoredPath(row?.file_path);
  const fp = storedFp && existsSync(storedFp)
    ? storedFp
    : imageFilePath(id, row?.name ?? `image_${id}`);
  writeFileSync(fp, input.data);
  // 未显式提供缩略图时用新原图自动生成（图片被替换后缩略图必须同步更新）
  const thumbBuf = input.thumbnail && input.thumbnail.length > 0 ? input.thumbnail : downscalePng(input.data, THUMB_MAX);
  let tp: string | null = null;
  if (thumbBuf) {
    tp = imageThumbPath(id);
    try {
      writeFileSync(tp, thumbBuf);
      thumbFailed.delete(id);
    } catch (e) {
      console.error(`[thumb] write failed for image ${id}:`, e);
      tp = null;
    }
  } else {
    thumbFailed.add(id);
  }
  db.prepare(
    `UPDATE images SET data = NULL, thumbnail = NULL, file_path = ?, thumb_path = ?, width = ?, height = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(toStoredPath(fp), tp ? toStoredPath(tp) : null, input.width, input.height, id);
}

export function moveImage(id: number, categoryId: number | null): void {
  db.prepare(
    `UPDATE images SET category_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(categoryId, id);
}

export function batchMoveImages(ids: number[], categoryId: number | null): void {
  const stmt = db.prepare(
    `UPDATE images SET category_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  );
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(categoryId, id);
  });
  tx();
}

function deleteImageFiles(id: number): void {
  const row = getImageData(id);
  if (!row) return;
  const fp = resolveStoredPath(row.file_path);
  const tp = resolveStoredPath(row.thumb_path);
  if (fp && existsSync(fp)) {
    try { unlinkSync(fp); } catch { /* ignore */ }
  }
  if (tp && existsSync(tp)) {
    try { unlinkSync(tp); } catch { /* ignore */ }
  }
}

export function deleteImage(id: number): void {
  deleteImageFiles(id);
  db.prepare(`DELETE FROM images WHERE id = ?`).run(id);
}

export function batchDeleteImages(ids: number[]): void {
  const stmt = db.prepare(`DELETE FROM images WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const id of ids) {
      deleteImageFiles(id);
      stmt.run(id);
    }
  });
  tx();
}

export function getImagesByIds(ids: number[]): ImageRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM images WHERE id IN (${placeholders})`)
    .all(...ids) as ImageRow[];
}

// ============ 模块加载即执行 ============
/**
 * 把历史遗留的绝对路径（带盘符，如 F:\...）改写为相对路径。
 * 只要成功跑一次，此后无论移动硬盘挂到哪个盘符，图片都不会再丢失。
 */
normalizeStoredPaths();
