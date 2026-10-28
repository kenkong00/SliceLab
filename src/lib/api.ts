// ============ 类型 ============
export interface Category {
  id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
  created_at: string;
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

export interface ListImagesResult {
  items: ImageMeta[];
  total: number;
}

export interface PackOptions {
  maxWidth: number;
  maxHeight: number;
  padding: number;
  border: number;
  allowRotation: boolean;
  powerOfTwo: boolean;
  square: boolean;
  smart: boolean;
  baseName: string;
  asZip?: boolean;
  pixelFormat?: string;
}

// ============ API 基础 ============
const API_BASE = "/api";

async function request<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = `请求失败 ${res.status}`;
    try {
      const err = await res.json();
      if (err.error) msg = err.error;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return res.json() as Promise<T>;
  }
  return res.blob() as unknown as Promise<T>;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // 去掉 data:image/png;base64, 前缀
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ============ 分类 API ============
export const api = {
  // Categories
  listCategories: () => request<Category[]>("/categories"),

  createCategory: (name: string, parentId: number | null = null) =>
    request<Category>("/categories", {
      method: "POST",
      body: JSON.stringify({ name, parent_id: parentId }),
    }),

  updateCategory: (
    id: number,
    patch: { name?: string; parent_id?: number | null }
  ) =>
    request<{ ok: boolean }>(`/categories/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  deleteCategory: (id: number) =>
    request<{ ok: boolean }>(`/categories/${id}`, { method: "DELETE" }),

  // Images
  listImages: (opts: {
    categoryId?: number | null;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}) => {
    const params = new URLSearchParams();
    if (opts.categoryId !== undefined) {
      params.set("category_id", opts.categoryId === null ? "null" : String(opts.categoryId));
    }
    if (opts.search) params.set("search", opts.search);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return request<ListImagesResult>(`/images${qs ? `?${qs}` : ""}`);
  },

  getImageFileUrl: (id: number, version?: string) =>
    `${API_BASE}/images/${id}/file${version ? `?v=${encodeURIComponent(version)}` : ""}`,
  getImageThumbnailUrl: (id: number, version?: string) =>
    `${API_BASE}/images/${id}/thumbnail${version ? `?v=${encodeURIComponent(version)}` : ""}`,

  uploadImage: async (file: File, categoryId: number | null = null) => {
    const fd = new FormData();
    fd.append("file", file);
    if (categoryId !== null) fd.append("category_id", String(categoryId));
    const res = await fetch(`${API_BASE}/images/upload`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) throw new Error("上传失败");
    return res.json() as Promise<{ id: number }>;
  },

  /**
   * 批量从 Blob 导入图片到素材库。
   * @param items 图片数组：name + blob + 宽高
   * @param categoryId 目标分类，null 为未分类
   */
  batchImport: async (
    items: { name: string; blob: Blob; width: number; height: number; pixelCount?: number; sourceFile?: string }[],
    categoryId: number | null = null
  ): Promise<{ ids: number[] }> => {
    const payload = {
      category_id: categoryId,
      items: [] as {
        name: string;
        data_base64: string;
        width: number;
        height: number;
        pixel_count?: number;
        source_file?: string;
      }[],
    };
    for (const it of items) {
      const base64 = await blobToBase64(it.blob);
      payload.items.push({
        name: it.name,
        data_base64: base64,
        width: it.width,
        height: it.height,
        pixel_count: it.pixelCount,
        source_file: it.sourceFile,
      });
    }
    return request<{ ids: number[] }>("/images/batch", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  updateImage: (
    id: number,
    patch: { name?: string; category_id?: number | null }
  ) =>
    request<{ ok: boolean }>(`/images/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  /** 替换图片像素数据（编辑器保存）。dataBlob 为编辑后的 PNG Blob */
  updateImageData: async (id: number, dataBlob: Blob) => {
    const base64 = await blobToBase64(dataBlob);
    return request<{ ok: boolean; width: number; height: number }>(
      `/images/${id}/data`,
      {
        method: "PUT",
        body: JSON.stringify({ data_base64: base64 }),
      }
    );
  },

  batchMoveImages: (ids: number[], categoryId: number | null) =>
    request<{ ok: boolean; moved: number }>("/images/batch-move", {
      method: "POST",
      body: JSON.stringify({ ids, category_id: categoryId }),
    }),

  /** 批量改名：按 ids 顺序命名为 prefix1, prefix2, ... */
  batchRenameImages: (ids: number[], prefix: string) =>
    request<{ ok: boolean; renamed: number }>("/images/batch-rename", {
      method: "POST",
      body: JSON.stringify({ ids, prefix }),
    }),

  deleteImage: (id: number) =>
    request<{ ok: boolean }>(`/images/${id}`, { method: "DELETE" }),

  batchDeleteImages: (ids: number[]) =>
    request<{ ok: boolean; deleted: number }>("/images/batch-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  /** 批量下载：返回 ZIP Blob */
  batchDownloadImages: async (ids: number[]): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/images/batch-download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error("批量下载失败");
    return res.blob();
  },

  /**
   * 打包图集。返回 ZIP Blob（包含 atlas.png + atlas.plist）
   */
  packAtlas: async (ids: number[], options: PackOptions): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/atlas/pack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, options, format: "zip" }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "打包失败");
    }
    return res.blob();
  },
};
