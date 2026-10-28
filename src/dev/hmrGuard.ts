/**
 * 开发环境 HMR 守卫
 *
 * 背景：Vite 6.0.9 起，HMR 的 WebSocket 连接必须带一个「每次启动随机生成」的
 * token（见 vite 的 legacy.skipWebSocketTokenCheck 说明）。一旦 dev server 重启——
 * 改了 vite.config.ts、进程被杀、启动器自愈重启——已经打开的标签页手里还是
 * 上一个进程的 token，服务端会直接回 HTTP 400，于是控制台一直刷：
 *
 *   WebSocket connection to 'ws://localhost:5180/?token=xxx' failed
 *   [vite] failed to connect to websocket.
 *
 * 而且它不会自愈（客户端重试用的还是那个死 token），只能手动 F5。
 *
 * 做法：定期拉一次 /@vite/client，比对里面的 wsToken。变了就说明 dev server
 * 重启过，自动刷新页面拿新 token，HMR 立刻恢复。
 *
 * 只在 import.meta.env.DEV 下动态引入，不会进生产包。
 */

const POLL_MS = 15_000;
const CLIENT_URL = "/@vite/client";
const RELOAD_KEY = "slicelab:hmr-guard-reloads";
const MAX_RELOADS = 10;

function extractToken(src: string): string | null {
  const m = src.match(/wsToken\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function reloadCount(): number {
  try {
    return Number(sessionStorage.getItem(RELOAD_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function bumpReloadCount(): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(reloadCount() + 1));
  } catch {
    /* 隐私模式下 sessionStorage 不可用，忽略 */
  }
}

export function installHmrGuard(): void {
  let mine: string | null = null;
  let checking = false;
  let reloading = false;

  function reload(): void {
    if (reloading) return;
    if (reloadCount() >= MAX_RELOADS) {
      console.warn(
        "[SliceLab] 开发服务器重启过于频繁，已停止自动刷新。请手动刷新页面恢复 HMR。"
      );
      return;
    }
    reloading = true;
    bumpReloadCount();
    console.info("[SliceLab] 检测到 Vite 开发服务器已重启，正在刷新页面以恢复热更新…");
    setTimeout(() => location.reload(), 300);
  }

  async function check(): Promise<void> {
    if (checking || reloading) return;
    checking = true;
    try {
      const res = await fetch(CLIENT_URL, { cache: "no-store" });
      if (!res.ok) return; // 服务暂时不可用，下一轮再试
      const token = extractToken(await res.text());
      if (!token) return;
      if (mine === null) {
        mine = token; // 首次只记录基线
        return;
      }
      if (token !== mine) reload();
    } catch {
      /* 拉取失败 = 服务没起来，保持轮询即可 */
    } finally {
      checking = false;
    }
  }

  console.debug("[SliceLab] HMR 守卫已启动");
  // 开发调试用：手动制造一次「token 过期」，验证自动刷新链路
  (window as unknown as Record<string, unknown>).__hmrGuard = {
    simulateStaleToken: () => {
      mine = "STALE";
    },
  };

  void check();
  setInterval(() => void check(), POLL_MS);
  // 标签页从后台切回来时立刻校验一次（休眠期间很可能已经重启过）
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void check();
  });
}
