# pi-lazy-transcript

Windowed, lazily-loading transcript rendering for [pi](https://pi.dev) — keeps frame cost flat as a session grows, and loads older messages only when you scroll up to them.

> **Status:** developed and measured on **pi 1.5.0**. It patches two `@earendil-works/pi-tui` prototypes (no fork, no rebuild). If a future pi changes those internals the plugin degrades to a no-op instead of breaking your session — verify with `PI_LAZY_STATS_FILE` before relying on it.

## Why

pi's TUI has no transcript virtualization. Every frame walks *every* message component of the session (`Container.prototype.render`), and every rendered message keeps its lines resident. Long sessions therefore pay more per frame and hold more memory than the visible screen needs.

Measured on a real 2200-message / 17 MB session: the transcript walk is ~0.5 ms per frame — small, but paid forever, and it grows linearly. This plugin makes it constant.

| messages x lines | window | full render | windowed | speedup |
|---|---|---|---|---|
| 2200 x 20 (44K lines) | 60 | 0.47-0.53 ms/frame | 0.01 ms/frame | **~40x** |
| 2200 x 20 (44K lines) | 400 | 0.47 ms/frame | 0.06 ms/frame | **~8x** |
| 5000 x 20 (100K lines) | 60 | 0.76 ms/frame | 0.01 ms/frame | **~60x** |

Single-run numbers on pi / pi-tui 1.5.0, Apple silicon; expect ±20% noise between runs, and the absolute saving is sub-millisecond — this plugin keeps a *constant* cost, it is not a remedy for a session that is slow for other reasons.

`npm run bench` reproduces this against your installed pi-tui.

## Install

```bash
# from a local checkout
pi install /path/to/pi-lazy-transcript

# or drop it into your user extensions directory
cp -R pi-lazy-transcript ~/.pi/agent/extensions/
```

Restart pi. Enabled by default (window = 60 messages).

## Usage

```
/lazy                    # status: window, folded count, scroll position
/lazy 300                # keep the newest 300 messages
/lazy window=300         # same
/lazy window 300         # same
/lazy more 100           # load 100 more older messages now
/lazy chunk 120          # how many messages one scroll-load adds (default 60)
/lazy reset              # back to the base window
/lazy off                # disable, render everything as stock pi
```

### Sliding window

Scroll up near the top and the window grows by `chunk` messages, then repaints — repeatedly, until the whole history is loaded:

```
60 -> 120 -> 180 -> 240 -> 300 -> ... -> 605 (all)
```

Messages outside the window collapse into one line: `... N earlier messages folded`.

Nothing is deleted or hidden from the model: the session file, `/export`, transcript search and the provider context are untouched. Only *rendering* is windowed. The window does not shrink on its own (so scrolling back down never makes content vanish) — use `/lazy reset`.

## How it works

| patch point | what it does |
|---|---|
| `Container.prototype.render` | if a container has more than `windowSize` children, render only the newest `windowSize` and prepend one collapsed marker; children are swapped in place and restored in a `finally`. Re-entrancy guarded so nested containers (a message with hundreds of children) still render in full. `VStack`/`Stack` children are skipped (they keep a parallel `entries` array). |
| `ScrollView.prototype.updateLayout` | the only place pi reports scroll geometry. Once the transcript has followed the end at least once, `scrollTop <= 1 viewport` grows the window by `chunk`; the plugin then invalidates the transcript container (pi otherwise reuses already-rendered lines) and requests one frame. |

`pi-tui` is imported by **bare specifier** so jiti resolves it to the same copy pi renders with — never add it as a dependency.

## Verify what it is doing

```bash
PI_LAZY_STATS_FILE=/tmp/lazy.log pi
# use pi normally, then:
cat /tmp/lazy.log
```

Events: `load:pitui=...`, `scroll:...`, `grow`, `command:...` with `windowSize`, `total`, `scrollTop`, `viewportHeight`, frame counts and folded counts.

## Limitations

- Rendering only. If a session feels slow, check the bigger offenders first: extensions that shell out on every tool call, and per-turn test/lint runners.
- Messages outside the window are not reachable with terminal scrollback until loaded (`/lazy more` or scrolling up).
- Patching internals is version-sensitive; measured against pi / pi-tui 1.5.0.
- Mouse hit-testing inside a windowed transcript maps to the rendered window, not the folded history.

## Development

```bash
npm run bench                    # 2200 x 20 lines, window 400
node scripts/bench.mjs 5000 20 60
```

`src/window.mjs` is pure logic (no pi imports) so it can be benchmarked and unit-tested outside a pi host; `index.ts` is thin wiring.

## License

MIT
