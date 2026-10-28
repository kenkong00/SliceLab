import JSZip from "jszip";
import { saveAs } from "file-saver";
import type { DetectedElement } from "@/types";

/**
 * 将元素打包为 ZIP 下载。
 * @param elements 待下载元素
 * @param baseName 基础文件名（不含扩展名），每个元素文件名为 `${baseName}_${index}.png`
 */
export async function downloadElementsAsZip(
  elements: DetectedElement[],
  baseName: string
): Promise<void> {
  if (elements.length === 0) return;

  const zip = new JSZip();
  const safeBase = sanitizeFileName(baseName) || "elements";

  elements.forEach((el) => {
    const idx = String(el.index + 1).padStart(3, "0");
    zip.file(`${safeBase}_${idx}.png`, el.blob);
  });

  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  saveAs(blob, `${safeBase}_slice.zip`);
}

/** 下载单个元素 */
export function downloadSingleElement(el: DetectedElement, baseName: string) {
  const idx = String(el.index + 1).padStart(3, "0");
  const safeBase = sanitizeFileName(baseName) || "element";
  const url = URL.createObjectURL(el.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeBase}_${idx}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .slice(0, 60);
}
