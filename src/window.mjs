import fs from "node:fs";

const __fs = fs;

/**
 * Core lazy-transcript logic — no pi imports, so it can be unit-tested and
 * benchmarked outside a pi host (`node scripts/bench.mjs`).
 *
 * Why this exists: pi's TUI has no transcript virtualization. Every frame calls
 * `Container.render(width)` on the transcript document, which walks *every*
 * message component of the session. Cost therefore grows with session length.
 *
 * What we do (真正的懒加载，而不是固定窗口):
 *  - 一个容器只渲染最近 `windowSize` 条子组件，更早的折叠成一行标记。
 *  - 「上滑才加载」：ScrollView 每次布局回报 `scrollTop` / `contentHeight` /
 *    `viewportHeight`。当用户滑到窗口顶部（scrollTop ≈ 0）且已经确认过
 *    「跟到末尾」状态，就把窗口再加 `chunk` 条，更早的历史才真正参与渲染。
 *  - 只有滚动到顶才增长，所以正常工作时帧成本恒定 = O(window)。
 */

/** Rough terminal display width: CJK, Hangul and emoji count as 2 columns. */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f)) continue; // ZWJ / combining marks
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Hard-truncate to `max` display columns, appending an ellipsis when cut. */
export function truncateToWidth(text, max) {
  const source = String(text);
  if (displayWidth(source) <= max) return source;
  let out = "";
  let used = 0;
  const ellipsis = "…";
  const budget = max - displayWidth(ellipsis);
  for (const ch of source) {
    const w = displayWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return out + ellipsis;
}

/** Marker component shown in place of the hidden history. */
export class CollapsedMarker {
  constructor(hiddenCount) {
    this.hiddenCount = hiddenCount;
  }

  render(width) {
    const n = this.hiddenCount;
    const max = Math.max(8, width - 1);
    const full = `⋯ 已折叠 ${n} 条更早消息 · 滑到顶部继续加载（/lazy reset 收起）`;
    const short = `⋯ 已折叠 ${n} 条更早消息`;
    const label = displayWidth(full) <= max ? full : short;
    return [truncateToWidth(label, max)];
  }

  invalidate() {}
}

/**
 * Patch a `render` method so a deep container renders only its newest children,
 * growing the window when the user scrolls to the top.
 *
 * Re-entrancy guarded: a windowed container never windows the containers nested
 * inside it (a message with 500 children must still render in full).
 */
export function patchContainerRender(origRender, getState, ownerKey = "__piLazyInside") {
  return function render(width) {
    const state = getState();
    const self = this;
    if (!state.enabled || state[ownerKey]) return origRender.call(self, width);

    const children = self?.children;
    // VStack/Stack keeps a parallel `entries` array; swapping `children` alone
    // would corrupt it, so those are left alone.
    if (!Array.isArray(children) || self.entries !== undefined) return origRender.call(self, width);

    const total = children.length;

    const windowSize = Math.max(1, Math.floor(state.windowSize));
    const hidden = total - windowSize;
    if (hidden <= 0) return origRender.call(self, width);

    state.lastTotal = total;
    state.transcriptContainer = self;
    const tail = children.slice(hidden);
    const marker = new CollapsedMarker(hidden);
    children.length = 0;
    children.push(marker, ...tail);

    state[ownerKey] = true;
    try {
      const lines = origRender.call(self, width);
      state.stats.frames += 1;
      state.stats.lastHidden = hidden;
      state.stats.maxHidden = Math.max(state.stats.maxHidden, hidden);
      state.stats.grownTo = state.windowSize;
      return lines;
    } finally {
      state[ownerKey] = false;
      children.length = 0;
      for (let i = 0; i < tail.length; i++) children.push(tail[i]);
    }
  };
}

/**
 * "上滑才加载": only grow when we are genuinely parked at the very top AND the
 * session has scrolled before (so a first frame with scrollTop === 0 before the
 * follow-end layout settled cannot unroll the whole history at once).
 */
export function maybeGrowWindow(state, total, now = Date.now()) {
  if (!state.enabled || !state.autoGrow) return false;
  const scroll = state.scroll;
  if (!scroll || !scroll.sawEnd) return false;
  const nearTop = Math.max(1, Math.round((scroll.viewportHeight || 0) * state.growNearTopViewports));
  if (scroll.scrollTop > nearTop) return false;
  if (state.windowSize >= total) return false;
  const moved = state.lastGrowScrollTop === undefined || state.scroll.scrollTop !== state.lastGrowScrollTop;
  const minInterval = moved ? state.growIntervalMs : Math.max(state.growIntervalMs, 800);
  if (now - (state.lastGrowAt ?? 0) < minInterval) return false;
  state.lastGrowScrollTop = state.scroll.scrollTop;
  state.windowSize = Math.min(total, state.windowSize + state.chunk);
  state.lastGrowAt = now;
  dumpStats(state, { event: "grow", total });
  return true;
}

export function createState(initial = {}) {
  return {
    enabled: initial.enabled ?? true,
    autoGrow: initial.autoGrow ?? true,
    windowSize: initial.windowSize ?? 60,
    baseWindowSize: initial.windowSize ?? 60,
    chunk: initial.chunk ?? 60,
    growIntervalMs: initial.growIntervalMs ?? 120,
    growNearTopViewports: initial.growNearTopViewports ?? 1,
    lastGrowAt: 0,
    lastGrowScrollTop: undefined,
    scroll: { scrollTop: 0, contentHeight: 0, viewportHeight: 0, sawEnd: false },
    stats: { frames: 0, lastHidden: 0, maxHidden: 0, grownTo: initial.windowSize ?? 60 },
  };
}

/** Parse `PI_LAZY_TRANSCRIPT` (`0` disables, `window=300`, `chunk=100`, `grow=off`). */
export function parseEnv(env = process.env) {
  const out = {};
  const raw = env.PI_LAZY_TRANSCRIPT;
  if (raw === undefined || raw === "") return out;
  if (raw === "0" || raw === "off" || raw === "false") out.enabled = false;
  const w = /(?:^|[,\s])window=(\d+)/.exec(raw);
  if (w) out.windowSize = Number(w[1]);
  const c = /(?:^|[,\s])chunk=(\d+)/.exec(raw);
  if (c) out.chunk = Number(c[1]);
  if (/(?:^|[,\s])grow=off/.test(raw)) out.autoGrow = false;
  return out;
}


/** Optional verification hook: append JSON lines when PI_LAZY_STATS_FILE is set. */
export function dumpStats(state, extra = {}) {
  const file = process.env.PI_LAZY_STATS_FILE;
  if (!file) return;
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event: extra.event ?? "snapshot",
      scrollInfo: extra.scrollInfo,
      enabled: state.enabled,
      autoGrow: state.autoGrow,
      windowSize: state.windowSize,
      baseWindowSize: state.baseWindowSize,
      chunk: state.chunk,
      total: extra.total,
      scrollTop: state.scroll?.scrollTop,
      viewportHeight: state.scroll?.viewportHeight,
      sawEnd: state.scroll?.sawEnd,
      stats: state.stats,
    });
    __fs.appendFileSync(file, line + "\n");
  } catch {
    /* stats are best-effort */
  }
}

/** Parse `/lazy` arguments: bare number, key=value, or `key value`, commas ok. */
export function parseLazyArgs(raw) {
  const parts = String(raw ?? "")
    .trim()
    .toLowerCase()
    .split(/[\s,，]+/)
    .filter(Boolean);
  if (parts.length === 0) return { cmd: "status" };

  const kv = {};
  const positional = [];
  for (const part of parts) {
    const m = /^([a-z_]+)=(\d+)$/.exec(part);
    if (m) kv[m[1]] = Number(m[2]);
    else positional.push(part);
  }

  let cmd = positional[0];
  if (cmd === undefined) cmd = Object.keys(kv)[0] ?? "status";

  // `/lazy 500` == `/lazy window 500`
  if (/^\d+$/.test(cmd)) {
    return { cmd: "window", value: Number(cmd) };
  }
  if (kv.window !== undefined && cmd === "window") return { cmd, value: kv.window };
  if (kv.chunk !== undefined && cmd === "chunk") return { cmd, value: kv.chunk };
  if (kv.more !== undefined && cmd === "more") return { cmd, value: kv.more };
  if (kv[cmd] !== undefined) return { cmd, value: kv[cmd] };

  const numeric = positional.slice(1).find((p) => /^\d+$/.test(p));
  return { cmd, value: numeric === undefined ? undefined : Number(numeric) };
}
