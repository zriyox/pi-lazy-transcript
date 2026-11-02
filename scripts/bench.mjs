/**
 * Benchmark: full transcript render vs windowed render, on pi's real pi-tui.
 *
 *   node scripts/bench.mjs [messages] [linesPerMessage] [windowSize]
 *
 * Resolves pi-tui from the managed install root so the measurement uses the
 * exact classes pi renders with.
 */
import fs from "node:fs";
import path from "node:path";
import { createState, patchContainerRender } from "../src/window.mjs";

const root = process.env.PI_MANAGED_INSTALL_ROOT ?? `${process.env.HOME}/.pi/agent/install`;
const version = fs.readFileSync(path.join(root, "current-version"), "utf8").trim();
const tuiPath = path.join(root, "releases", version, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
const tui = await import(tuiPath);
const { Container, Text } = tui;

const messages = Number(process.argv[2] ?? 2200);
const linesPer = Number(process.argv[3] ?? 8);
const windowSize = Number(process.argv[4] ?? 400);
const width = 120;

function buildDocument(n) {
  const doc = new Container();
  for (let i = 0; i < n; i++) {
    const body = Array.from({ length: linesPer }, (_, j) => `message ${i} line ${j}: some assistant/tool output text at a realistic width`).join("\n");
    doc.addChild(new Text(body, 1, 0));
  }
  return doc;
}

function timeRender(doc, frames = 20) {
  doc.render(width); // warm component caches
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) doc.render(width);
  return (performance.now() - t0) / frames;
}

const docFull = buildDocument(messages);
const fullMs = timeRender(docFull);

const state = createState({ enabled: true, windowSize });
const original = Container.prototype.render;
Container.prototype.render = patchContainerRender(original, () => state);
const docWindowed = buildDocument(messages);
const windowedMs = timeRender(docWindowed);
const windowedLines = docWindowed.render(width).length;
Container.prototype.render = original;

console.log(
  `messages=${messages} lines/msg=${linesPer} window=${windowSize} width=${width}\n` +
    `  full render      : ${fullMs.toFixed(2)} ms/frame  (${docFull.render(width).length} lines)\n` +
    `  windowed render  : ${windowedMs.toFixed(2)} ms/frame  (${windowedLines} lines)\n` +
    `  speedup          : ${(fullMs / Math.max(windowedMs, 0.001)).toFixed(1)}x   ` +
    `60fps budget used: ${((windowedMs / 16.7) * 100).toFixed(1)}%`,
);
