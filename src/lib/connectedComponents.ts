import type { BBox } from "@/types";

export interface ConnectedRegion {
  /** 像素索引列表（一维 index） */
  pixels: number[];
  bbox: BBox;
  pixelCount: number;
}

/**
 * 对 ImageData 的 alpha 通道执行 8 邻域连通区域标记（迭代 BFS）。
 * 返回所有连通区域（未过滤）。
 *
 * 性能优化：
 * - 使用 Uint8Array visited 而非 number[]
 * - 使用栈数组而非递归
 * - 跳过 alpha = 0 像素
 */
export function findConnectedRegions(
  imageData: ImageData,
  minSize: number,
  onProgress?: (percent: number) => void
): ConnectedRegion[] {
  const { width, height, data } = imageData;
  const total = width * height;
  const visited = new Uint8Array(total);
  const regions: ConnectedRegion[] = [];

  // 8 邻域偏移
  const dx = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy = [-1, -1, -1, 0, 0, 1, 1, 1];

  const stack: number[] = new Array(1024);
  let stackLen = 0;

  let lastReport = 0;

  for (let p = 0; p < total; p++) {
    if (visited[p]) continue;
    const alpha = data[p * 4 + 3];
    if (alpha === 0) {
      visited[p] = 1;
      continue;
    }

    // BFS
    stackLen = 0;
    stack[stackLen++] = p;
    visited[p] = 1;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    const pixels: number[] = [];
    const startPx = p % width;
    const startPy = (p / width) | 0;
    minX = startPx;
    minY = startPy;
    maxX = startPx;
    maxY = startPy;

    while (stackLen > 0) {
      const cur = stack[--stackLen];
      pixels.push(cur);
      const cx = cur % width;
      const cy = (cur / width) | 0;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      for (let k = 0; k < 8; k++) {
        const nx = cx + dx[k];
        const ny = cy + dy[k];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (visited[np]) continue;
        const na = data[np * 4 + 3];
        if (na === 0) {
          visited[np] = 1;
          continue;
        }
        visited[np] = 1;
        // 扩容
        if (stackLen === stack.length) {
          stack.push(0);
        }
        stack[stackLen++] = np;
      }
    }

    if (pixels.length >= minSize) {
      regions.push({
        pixels,
        pixelCount: pixels.length,
        bbox: {
          x: minX,
          y: minY,
          w: maxX - minX + 1,
          h: maxY - minY + 1,
        },
      });
    }

    // 进度上报
    if (onProgress && p - lastReport > total * 0.02) {
      lastReport = p;
      onProgress(Math.round((p / total) * 100));
    }
  }

  if (onProgress) onProgress(100);
  return regions;
}

/**
 * 从 ImageData 裁剪出指定 bbox 区域（含 padding 外扩，自动 clamp），
 * 返回新 Canvas + Blob。
 */
export async function cropRegionToPng(
  source: ImageData,
  bbox: BBox,
  padding: number
): Promise<{ canvas: HTMLCanvasElement; blob: Blob }> {
  const { width, height } = source;
  const x = Math.max(0, bbox.x - padding);
  const y = Math.max(0, bbox.y - padding);
  const x2 = Math.min(width, bbox.x + bbox.w + padding);
  const y2 = Math.min(height, bbox.y + bbox.h + padding);
  const w = x2 - x;
  const h = y2 - y;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D 上下文不可用");

  // 用 putImageData 而非 drawImage（直接操作 ImageData）
  // 需要先创建子 ImageData
  const sub = ctx.createImageData(w, h);
  const srcData = source.data;
  const dstData = sub.data;
  for (let row = 0; row < h; row++) {
    const srcRowStart = ((y + row) * width + x) * 4;
    const dstRowStart = row * w * 4;
    dstData.set(srcData.subarray(srcRowStart, srcRowStart + w * 4), dstRowStart);
  }
  ctx.putImageData(sub, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob 失败"))),
      "image/png"
    );
  });

  return { canvas, blob };
}
