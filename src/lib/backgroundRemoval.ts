import type { ProcessOptions, RGBColor } from "@/types";
import { colorDistance, detectBackgroundColor } from "./imageUtils";

/**
 * 在 ImageData 上执行背景去除。
 * - bgMode = 'transparent'：保留原 alpha 通道
 * - bgMode = 'auto'：自动检测四角色作为背景
 * - bgMode = 'picker'：使用用户提供的 bgColor
 *
 * 容差 0-100 → RGB 距离阈值 0-180
 *
 * 去背景方式（options.contiguous）：
 *   - true（默认）：从图片四边缘开始 BFS 洪水填充，仅移除与边缘连通的背景像素。
 *                  被前景包围的内部白色（眼白、衣领等）会被保留。
 *   - false：全局颜色匹配（旧逻辑），所有匹配背景色的像素都置透明。
 *
 * 白边优化（按白边参考实现，效率优先）：
 * 1) 边缘半透明像素颜色去污染：前景RGB = (原RGB - bgRGB × (1-α)) / α
 * 2) 可选：1px Alpha 腐蚀，切掉最污染的过渡带
 * 3) 可选：边缘轻羽化，平滑锯齿
 */
export function removeBackground(
  imageData: ImageData,
  options: ProcessOptions
): { data: ImageData; bgColor: RGBColor | null } {
  const { width, height, data } = imageData;
  const tolerance = options.tolerance / 100; // 0-1
  const threshold = tolerance * 180; // RGB 距离阈值

  let bgColor: RGBColor | null = null;

  if (options.bgMode === "transparent") {
    // 已有 alpha 通道：仅做边缘增强（去污染 / 腐蚀 / 羽化）
    if (options.antiAlias) {
      featherAlphaEdges(imageData);
    }
    // 对已有透明图，假设背景为白色做去污染（避免之前白底留色）
    bgColor = options.bgColor ?? { r: 255, g: 255, b: 255 };
    applyDecontaminate(imageData, bgColor, options.decontaminate);
    if (options.erodeAlpha > 0) applyAlphaErode(imageData, options.erodeAlpha);
    return { data: imageData, bgColor };
  }

  if (options.bgMode === "picker" && options.bgColor) {
    bgColor = options.bgColor;
  } else {
    bgColor = detectBackgroundColor(imageData);
  }

  if (options.contiguous) {
    // ===== 连通去背景（推荐）：从边缘洪水填充 =====
    // 1) BFS 标记所有"与边缘连通且匹配背景色"的像素 → backgroundMask
    // 2) mask 中的像素 alpha=0；mask 外但处于过渡带的像素做半透明
    // 3) 被前景包围的内部白色（dist<=threshold 但 BFS 到不了）→ 保留
    const bgMask = floodFillBackground(
      imageData,
      bgColor,
      threshold
    );

    for (let p = 0; p < bgMask.length; p++) {
      if (bgMask[p]) {
        // 与边缘连通的背景像素：完全透明
        data[p * 4 + 3] = 0;
        continue;
      }
      if (options.antiAlias) {
        // 仅对"与背景区域相邻的前景边缘像素"做半透明过渡
        // 判断条件：不在 bgMask 中，但 4 邻域有 bgMask 像素，且自身颜色处于过渡带
        const x = p % width;
        const y = (p / width) | 0;
        const i = p * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const dist = colorDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b);
        if (dist > threshold && dist <= threshold * 1.4) {
          // 进一步判断是否与背景区域相邻
          let touchBg = false;
          if (x > 0 && bgMask[p - 1]) touchBg = true;
          else if (x < width - 1 && bgMask[p + 1]) touchBg = true;
          else if (y > 0 && bgMask[p - width]) touchBg = true;
          else if (y < height - 1 && bgMask[p + width]) touchBg = true;
          if (touchBg) {
            const t = (dist - threshold) / (threshold * 0.4);
            data[i + 3] = Math.min(255, Math.round(data[i + 3] * t));
          }
        }
      }
    }
  } else {
    // ===== 旧逻辑：全局颜色匹配 =====
    // 遍历像素，符合背景色的置 alpha=0；过渡带按距离插值得到半透明
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const dist = colorDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b);
      if (dist <= threshold) {
        data[i + 3] = 0;
      } else if (options.antiAlias && dist <= threshold * 1.4) {
        // 边缘半透明：根据距离插值
        const t = (dist - threshold) / (threshold * 0.4);
        data[i + 3] = Math.min(255, Math.round(data[i + 3] * t));
      }
    }
  }

  // 颜色去污染：在背景已擦除、边缘半透明像素上做去白边
  applyDecontaminate(imageData, bgColor, options.decontaminate);

  // 可选 Alpha 腐蚀（针对游戏/卡通素材，彻底去白边）
  if (options.erodeAlpha > 0) applyAlphaErode(imageData, options.erodeAlpha);

  return { data: imageData, bgColor };
}

/**
 * 从图片四边缘开始的洪水填充（BFS）。
 * 仅通过"与背景色距离 <= threshold"的像素传播，返回所有被访问到的像素 mask。
 *
 * 这样被前景完全包围的内部白色（如眼白、衣领）不会被 BFS 到达，从而保留。
 *
 * 性能：O(W×H)，单次线性扫描，使用 Uint8Array mask 和预分配栈。
 */
function floodFillBackground(
  imageData: ImageData,
  bgColor: RGBColor,
  threshold: number
): Uint8Array {
  const { width, height, data } = imageData;
  const total = width * height;
  const mask = new Uint8Array(total); // 1 = 与边缘连通的背景像素

  // 4 邻域（保持背景区域连通性，避免穿透前景细缝）
  const dx = [-1, 1, 0, 0];
  const dy = [0, 0, -1, 1];

  // 预分配栈
  const stack: number[] = new Array(Math.max(width, height) * 4);
  let stackLen = 0;

  // 判断像素是否匹配背景色
  const isBackground = (p: number): boolean => {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const dist = colorDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b);
    return dist <= threshold;
  };

  // 从四边缘所有匹配背景色的像素入队
  // 上边
  for (let x = 0; x < width; x++) {
    const p = x;
    if (!mask[p] && isBackground(p)) {
      mask[p] = 1;
      stack[stackLen++] = p;
    }
  }
  // 下边
  for (let x = 0; x < width; x++) {
    const p = (height - 1) * width + x;
    if (!mask[p] && isBackground(p)) {
      mask[p] = 1;
      stack[stackLen++] = p;
    }
  }
  // 左边
  for (let y = 0; y < height; y++) {
    const p = y * width;
    if (!mask[p] && isBackground(p)) {
      mask[p] = 1;
      stack[stackLen++] = p;
    }
  }
  // 右边
  for (let y = 0; y < height; y++) {
    const p = y * width + (width - 1);
    if (!mask[p] && isBackground(p)) {
      mask[p] = 1;
      stack[stackLen++] = p;
    }
  }

  // BFS
  while (stackLen > 0) {
    const cur = stack[--stackLen];
    const cx = cur % width;
    const cy = (cur / width) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = cx + dx[k];
      const ny = cy + dy[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const np = ny * width + nx;
      if (mask[np]) continue;
      if (!isBackground(np)) continue;
      mask[np] = 1;
      // 扩容
      if (stackLen === stack.length) {
        stack.push(0);
      }
      stack[stackLen++] = np;
    }
  }

  return mask;
}

/**
 * 颜色去污染（Decontaminate Colors）。
 * 公式：前景RGB = (原RGB - bgRGB × (1 - α)) / α
 * 仅作用于半透明像素（alpha 在 [1, 254] 区间），完全透明 / 不透明像素跳过。
 * 单次线性扫描，性能 O(N)，几乎无开销。
 */
function applyDecontaminate(
  imageData: ImageData,
  bgColor: RGBColor,
  enabled: boolean
) {
  if (!enabled) return;
  const { data } = imageData;
  const bgR = bgColor.r;
  const bgG = bgColor.g;
  const bgB = bgColor.b;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0 || a === 255) continue;
    const alpha = a / 255;
    const inv = 1 - alpha;
    // 前景色 = (原色 - 背景色 × (1-α)) / α
    let r = (data[i] - bgR * inv) / alpha;
    let g = (data[i + 1] - bgG * inv) / alpha;
    let b = (data[i + 2] - bgB * inv) / alpha;
    // clamp 到 [0, 255]
    data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

/**
 * Alpha 通道向内腐蚀 N 像素。
 * 迭代 N 次：每次把"与透明像素相邻的不透明像素"alpha 减半，形成 N 像素过渡带。
 * 性能 O(N × W × H)，对 1024×1024 + N=5 约 5M 次操作，毫秒级。
 */
function applyAlphaErode(imageData: ImageData, px: number) {
  const { width, height, data } = imageData;
  if (px <= 0 || width < 3 || height < 3) return;
  const size = width * height;
  let current = new Uint8ClampedArray(size);
  for (let p = 0; p < size; p++) current[p] = data[p * 4 + 3];
  for (let iter = 0; iter < px; iter++) {
    const next = new Uint8ClampedArray(current);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const a = current[p];
        if (a === 0) continue;
        const left = x > 0 ? current[p - 1] : a;
        const right = x < width - 1 ? current[p + 1] : a;
        const up = y > 0 ? current[p - width] : a;
        const down = y < height - 1 ? current[p + width] : a;
        if (left === 0 || right === 0 || up === 0 || down === 0) {
          next[p] = a >> 1;
        }
      }
    }
    current = next;
  }
  for (let p = 0; p < size; p++) data[p * 4 + 3] = current[p];
}

/**
 * 对 alpha 通道做 1px 边缘羽化（用于已透明图片）。
 * 简单 3x3 box blur 应用于 alpha 通道的边缘像素。
 */
function featherAlphaEdges(imageData: ImageData) {
  const { width, height, data } = imageData;
  if (width < 3 || height < 3) return;
  // 仅对边缘像素（alpha 在 [1, 254]）做轻量模糊
  const origAlpha = new Uint8ClampedArray(width * height);
  for (let p = 0; p < width * height; p++) {
    origAlpha[p] = data[p * 4 + 3];
  }
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const a = origAlpha[p];
      if (a === 0 || a === 255) continue;
      // 3x3 平均
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += origAlpha[p + dy * width + dx];
        }
      }
      data[p * 4 + 3] = Math.round(sum / 9);
    }
  }
}
