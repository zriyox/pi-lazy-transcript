/**
 * pi-lazy-transcript — windowed transcript rendering for pi.
 *
 * Problem: pi's TUI has no transcript virtualization. Every frame walks every
 * message component of the session (`Container.render`), so frame cost and
 * resident memory grow with session length.
 *
 * Fix: patch `Container.prototype.render` so a container with more than
 * `windowSize` children renders only its newest `windowSize` children, with one
 * collapsed marker line for the rest. Nothing is deleted: the session file,
 * /export, search and the model context are untouched.
 *
 * 关于「上滑自动加载」：pi 1.5 在滚动时不会重建组件树（滚动只复用已渲染的行），
 * 所以扩展拿不到「滚到顶就继续渲染更早消息」的挂点。这里给的是显式加载：
 * `/lazy more 100` 把窗口加 100 条并主动请求一帧，实测会真正重绘。
 *
 * pi-tui is imported by BARE specifier: jiti aliases it to the exact copy pi
 * renders with, so the real prototypes get patched. Never add it as a dependency.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createState, dumpStats, maybeGrowWindow, parseEnv, parseLazyArgs, patchContainerRender } from "./src/window.mjs";

const STATE_KEY = Symbol.for("pi-lazy-transcript.state");
const PATCH_KEY = Symbol.for("pi-lazy-transcript.patched");
const SCROLL_PATCH_KEY = Symbol.for("pi-lazy-transcript.scroll-patched");

type LazyState = {
  enabled: boolean;
  autoGrow: boolean;
  windowSize: number;
  baseWindowSize: number;
  chunk: number;
  lastTotal?: number;
  requestRender?: () => void;
  scroll: { scrollTop: number; contentHeight: number; viewportHeight: number; sawEnd: boolean };
  stats: { frames: number; lastHidden: number; maxHidden: number; grownTo: number };
};

const USAGE =
  "用法: /lazy | /lazy on|off | /lazy 500 | /lazy window=500 | /lazy window 500 | " +
  "/lazy more 100 | /lazy chunk 100 | /lazy reset";

function getState(): LazyState {
  const g = globalThis as any;
  if (!g[STATE_KEY]) g[STATE_KEY] = createState(parseEnv());
  return g[STATE_KEY] as LazyState;
}

/** Resolve the pi-tui copy pi itself renders with. */
async function resolveTui(): Promise<any | null> {
  try {
    return await import("@earendil-works/pi-tui");
  } catch {
    /* fall through to install-root lookup */
  }
  const root = process.env.PI_MANAGED_INSTALL_ROOT;
  if (!root) return null;
  const fs = await import("node:fs");
  const candidates: string[] = [];
  try {
    const version = fs.readFileSync(`${root}/current-version`, "utf8").trim();
    candidates.push(`${root}/releases/${version}/node_modules/@earendil-works/pi-tui/dist/index.js`);
  } catch {
    /* ignore */
  }
  try {
    for (const name of fs.readdirSync(`${root}/releases`).sort().reverse()) {
      candidates.push(`${root}/releases/${name}/node_modules/@earendil-works/pi-tui/dist/index.js`);
    }
  } catch {
    /* ignore */
  }
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch {
      /* try next */
    }
  }
  return null;
}

export default async function (pi: ExtensionAPI) {
  const state = getState();
  const tui = await resolveTui();
  dumpStats(state, { event: `load:pitui=${Boolean(tui?.Container)}` });

  if (!tui?.Container?.prototype) {
    // Headless runs and non-TUI hosts have nothing to patch.
    return;
  }

  const g = globalThis as any;
  if (!g[PATCH_KEY]) {
    tui.Container.prototype.render = patchContainerRender(tui.Container.prototype.render, getState);
    g[PATCH_KEY] = true;
  }

  // Capture the scroll layout callback so commands can force a repaint.
  const ScrollView = tui.ScrollView;
  if (ScrollView?.prototype?.updateLayout && !g[SCROLL_PATCH_KEY]) {
    const originalUpdateLayout = ScrollView.prototype.updateLayout;
    ScrollView.prototype.updateLayout = function (contentHeight, viewportHeight, requestRender) {
      const result = originalUpdateLayout.call(this, contentHeight, viewportHeight, requestRender);
      if (this.primary) {
        state.scroll.scrollTop = this.currentScrollTop ?? 0;
        state.scroll.contentHeight = contentHeight ?? 0;
        state.scroll.viewportHeight = viewportHeight ?? 0;
        if (typeof requestRender === "function") state.requestRender = requestRender;
        if (state.scroll.scrollTop > 0) state.scroll.sawEnd = true;

        // 滑动窗口：滚到顶部就自动加载更早的历史，并强制重绘一帧。
        const total = state.lastTotal ?? 0;
        if (total > state.windowSize && maybeGrowWindow(state, total)) {
          (state as any).transcriptContainer?.invalidate?.();
          if (typeof requestRender === "function") requestRender();
        }
      }
      return result;
    };
    g[SCROLL_PATCH_KEY] = true;
  }

  const repaint = () => {
    try {
      // 先清缓存再请求一帧，否则 pi 会复用已渲染的行，窗口改动不生效。
      (state as any).transcriptContainer?.invalidate?.();
      state.requestRender?.();
    } catch {
      /* best effort */
    }
  };

  pi.registerCommand("lazy", {
    description:
      "Lazy transcript: /lazy [status|on|off|reset] · /lazy 500 · /lazy window=500 · /lazy more 100 · /lazy chunk 100",
    handler: async (arg, ctx) => {
      const { cmd, value } = parseLazyArgs(arg);
      const total = state.lastTotal ?? 0;

      switch (cmd) {
        case "on":
          state.enabled = true;
          break;
        case "off":
          state.enabled = false;
          break;
        case "reset":
          state.windowSize = state.baseWindowSize;
          break;
        case "status":
          break;
        case "grow": {
          const v = String(arg ?? "").toLowerCase();
          state.autoGrow = !/(^|[\s,])off/.test(v);
          break;
        }
        case "window":
        case "chunk":
        case "more": {
          if (value === undefined || !Number.isFinite(value) || value < 1) {
            ctx.ui.notify(USAGE, "info");
            return;
          }
          const n = Math.floor(value);
          if (cmd === "window") {
            state.windowSize = n;
            state.baseWindowSize = n;
          } else if (cmd === "chunk") {
            state.chunk = n;
          } else {
            state.windowSize = total > 0 ? Math.min(total, state.windowSize + n) : state.windowSize + n;
          }
          repaint();
          break;
        }
        default:
          ctx.ui.notify(USAGE, "info");
          return;
      }

      if (cmd !== "status") repaint();
      dumpStats(state, { event: `command:${cmd}` });
      ctx.ui.notify(
        `lazy: ${state.enabled ? "on" : "off"} · 保留最近 ${state.windowSize} 条${
          total > 0 ? `（会话共 ${total} 条，折叠 ${Math.max(0, total - state.windowSize)} 条）` : ""
        } · 折叠上线 ${state.stats.lastHidden} 条 · ${state.stats.frames} 帧 · ` +
          `scrollTop ${Math.round(state.scroll.scrollTop)} · 更多历史用 /lazy more 100`,
        "info",
      );
    },
  });
}
