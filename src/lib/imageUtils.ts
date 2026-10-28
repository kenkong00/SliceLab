import type { RGBColor } from "@/types";

/** 将 File 加载为 HTMLImageElement */
export function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // 不立即 revokeURL，因为可能需要复用；调用方负责
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(new Error(`图片加载失败: ${e}`));
    };
    img.src = url;
  });
}

/** 将 Image 绘制到 Canvas，可选缩放（长边超过 maxDim 时） */
export function imageToCanvas(
  img: HTMLImageElement,
  maxDim = 4000
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; scaled: boolean } {
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  let scaled = false;
  const longSide = Math.max(w, h);
  if (longSide > maxDim) {
    const ratio = maxDim / longSide;
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
    scaled = true;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D 上下文不可用");
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx, scaled };
}

/** 检测图像是否存在有意义的 alpha 通道 */
export function hasAlphaChannel(img: HTMLImageElement): boolean {
  // PNG / WEBP 可能带 alpha；通过临时 canvas 抽样一个像素判断
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  return data[3] < 255;
}

/** 取四角像素颜色，投票决定主背景色 */
export function detectBackgroundColor(
  imageData: ImageData
): RGBColor {
  const { width, height, data } = imageData;
  const corners: RGBColor[] = [
    pixelAt(data, width, 0, 0),
    pixelAt(data, width, width - 1, 0),
    pixelAt(data, width, 0, height - 1),
    pixelAt(data, width, width - 1, height - 1),
  ];
  // 取最相似的一对，再平均；如果四角相近就返回均值，否则返回出现最多的色
  // 简化：四角平均
  const avg: RGBColor = {
    r: Math.round((corners[0].r + corners[1].r + corners[2].r + corners[3].r) / 4),
    g: Math.round((corners[0].g + corners[1].g + corners[2].g + corners[3].g) / 4),
    b: Math.round((corners[0].b + corners[1].b + corners[2].b + corners[3].b) / 4),
  };
  // 若四角色差异大，退回到第一个角
  const variance = corners.reduce((acc, c) => {
    return acc + Math.abs(c.r - avg.r) + Math.abs(c.g - avg.g) + Math.abs(c.b - avg.b);
  }, 0);
  if (variance > 120) return corners[0];
  return avg;
}

function pixelAt(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number
): RGBColor {
  const i = (y * width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

/** RGB 颜色距离（简化欧式） */
export function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** 将 rgb 转为 hex 字符串 */
export function rgbToHex({ r, g, b }: RGBColor): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** 将 hex 转为 rgb */
export function hexToRgb(hex: string): RGBColor | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = m[1];
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

/** 触发浏览器下载（单文件） */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
