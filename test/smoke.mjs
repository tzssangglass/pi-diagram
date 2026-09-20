// Behavioral smoke tests through the extension's public factory/tool seams.
// Run: npm test  (needs node >= 23 for type stripping)
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setCapabilities,
  setCellDimensions,
} from "@earendil-works/pi-tui";

const liveEngine = process.env.DYNAMIC_DIAGRAM_TEST_BIN;

function kittyMetadata(line) {
  const columns = Number(line.match(/(?:^|,)c=(\d+)/)?.[1]);
  const imageId = Number(line.match(/(?:^|,)i=(\d+)/)?.[1]);
  return { columns, imageId };
}

const sandbox = mkdtempSync(join(tmpdir(), "pi-diagram-test-"));
const engine = join(sandbox, "fake-engine.mjs");
const engineLog = join(sandbox, "engine.jsonl");
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));

writeFileSync(engine, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify(args) + "\\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8z4AATAxEcQAz0gEAlmYBBMqX7WQAAAAASUVORK5CYII=", "base64");
if (args[0] === "spec" && args[1] === "--list-icons") {
  await sleep(35);
  console.log("dns\\npublic_dns\\nrouter");
  process.exit(0);
}
const specPath = args[1];
const spec = JSON.parse(readFileSync(specPath, "utf8"));
if (spec.ignoreTerm) process.on("SIGTERM", () => {});
if (spec.delayMs) await sleep(spec.delayMs);
if (spec.fail) {
  writeFileSync(2, "synthetic engine failure\\n");
  process.exit(7);
}
if (args[2] === "frames") {
  const out = args[3];
  const count = Number(args[4]);
  mkdirSync(out, { recursive: true });
  const files = [];
  for (let i = 0; i < count; i++) {
    const suffix = Buffer.alloc(Number(spec.framePadding || 0), i);
    const file = String(i + 1).padStart(5, "0") + ".png";
    files.push(file);
    writeFileSync(out + "/" + file, Buffer.concat([png, Buffer.from([i]), suffix]));
  }
  writeFileSync(out + "/99999.png", png); // not part of this export
  writeFileSync(out + "/frames.json", JSON.stringify({ files, count, duration: spec.duration, width: 760, height: 330, fps: count * 1000 / spec.duration }));
} else {
  writeFileSync(specPath.replace(/\\.json$/, ".png"), png);
}
`);
chmodSync(engine, 0o755);
process.env.DYNAMIC_DIAGRAM_BIN = engine;
process.env.FAKE_ENGINE_LOG = engineLog;
process.env.DD_DIAGRAM_TIMEOUT_MS = "300";
process.env.DD_ANIM_CACHE_BYTES = "160";

const registrations = { tools: [], commands: [], events: new Map() };
const pi = {
  registerTool: (tool) => registrations.tools.push(tool),
  registerCommand: (name, command) => registrations.commands.push({ name, ...command }),
  on: (event, handler) => registrations.events.set(event, handler),
};

const mod = await import(new URL("../extensions/index.ts", import.meta.url).href);
assert.equal(typeof mod.default, "function", "extension exports a default factory");
mod.default(pi);

const tool = registrations.tools.find((candidate) => candidate.name === "diagram");
assert.ok(tool, "diagram tool registered");
assert.ok(tool.description.length > 200, "tool description teaches the spec format");
assert.ok(tool.parameters, "tool has typebox parameters");
assert.ok(registrations.commands.some((command) => command.name === "diagram"), "/diagram command registered");
assert.ok(registrations.commands.some((command) => command.name === "anim"), "/anim command registered");
assert.equal(typeof registrations.events.get("session_shutdown"), "function", "session shutdown cleanup registered");

const execute = (id, params, signal) => tool.execute(id, params, signal, () => {}, { cwd: sandbox });
const calls = () => existsSync(engineLog)
  ? readFileSync(engineLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  : [];

// Both search and render must yield while their child process is running.
let yielded = false;
const searchPromise = execute("search", { search_icons: "dns" });
setImmediate(() => { yielded = true; });
const search = await searchPromise;
assert.equal(yielded, true, "icon search yields to the event loop");
assert.match(search.content[0].text, /dns/, "icon search returns matching names");

const staticStart = calls().length;
yielded = false;
const staticPromise = execute("static", { name: "still", spec: JSON.stringify({ delayMs: 35, nodes: [] }) });
setImmediate(() => { yielded = true; });
const still = await staticPromise;
assert.equal(yielded, true, "static render yields to the event loop");
assert.equal(still.content[0].type, "image", "static render returns an image");
assert.deepEqual(calls().slice(staticStart).map((args) => args[2]), [undefined], "static render invokes one poster render");

// Engine failures are reported; aborts kill the child and preserve AbortError semantics.
const failed = await execute("failure", { spec: JSON.stringify({ fail: true, nodes: [] }) });
assert.match(failed.content[0].text, /synthetic engine failure/, "engine stderr is reported");

const controller = new AbortController();
const cancelled = execute("cancel", { spec: JSON.stringify({ delayMs: 500, nodes: [] }) }, controller.signal);
setTimeout(() => controller.abort(), 15);
await assert.rejects(cancelled, (error) => error?.name === "AbortError", "abort cancels an active engine child");

const timeoutStart = performance.now();
const timedOut = await execute("timeout", { spec: JSON.stringify({ delayMs: 5000, ignoreTerm: true, nodes: [] }) });
assert.match(timedOut.content[0].text, /timed out/i, "render timeout is reported clearly");
assert.ok(performance.now() - timeoutStart < 2000, "timeout forcibly terminates an engine ignoring SIGTERM");

const durationStill = await execute("duration-still", { spec: JSON.stringify({ duration: 1000, nodes: [] }) });
assert.equal(durationStill.content[0].type, "image", "duration alone does not enable animation");
assert.equal(durationStill.details.frames, undefined, "default call remains static");
const disabled = await execute("explicit-static", { spec: JSON.stringify({ duration: 1000, nodes: [] }), animate: false });
assert.equal(disabled.content[0].type, "image", "animate false remains static");

// Frame generation follows duration * fps, caps work, and never pre-renders a poster.
const animationStart = calls().length;
const animated = await execute("anim-10fps", {
  name: "motion",
  spec: JSON.stringify({ duration: 1000, nodes: [] }),
  animate: true,
  fps: 10,
});
assert.equal(animated.details.frames.length, 10, "one-second animation at 10fps generates ten frames");
assert.equal(animated.details.durationMs, 1000, "playback retains the authored duration");
assert.equal(animated.content.length, 1, "animated result leaves single-image rendering to renderResult");
assert.equal(animated.content[0].type, "text", "animated result has no duplicate built-in image");
assert.equal(readFileSync(animated.details.png).equals(readFileSync(animated.details.frames[0])), true, "first generated frame becomes the poster");
const animationCalls = calls().slice(animationStart);
assert.equal(animationCalls.length, 1, "animation invokes the engine once");
assert.deepEqual(animationCalls[0].slice(2, 5), ["frames", animationCalls[0][3], "10"], "frame count is passed through the existing CLI contract");
assert.deepEqual(animationCalls[0].slice(-2), ["--density", "2"], "raster density is an explicit CLI output option");

const capped = await execute("anim-capped", {
  name: "long-motion",
  spec: JSON.stringify({ duration: 20_000, canvas: { scale: 2 }, nodes: [] }),
  animate: true,
});
assert.equal(capped.details.frames.length, 240, "generated frame work is capped");
assert.equal(capped.details.durationMs, 20_000, "capped playback still spans the full authored duration");
assert.equal(JSON.parse(readFileSync(capped.details.jsonPath, "utf8")).canvas.scale, 2, "presentation scale remains in the spec");
assert.notEqual(capped.details.frames[0].replace(/\/[^/]+$/, ""), animated.details.frames[0].replace(/\/[^/]+$/, ""), "each export owns a unique frame directory");

const defaultFps = await execute("default-fps", { spec: JSON.stringify({ duration: 1000, nodes: [] }), animate: true });
assert.equal(defaultFps.details.frames.length, 24, "default animation rate is 24fps");
for (const fps of [0, -1, Infinity, 121]) {
  const invalid = await execute("invalid-fps", { spec: JSON.stringify({ duration: 1000 }), animate: true, fps });
  assert.match(invalid.content[0].text, /fps/, "invalid frame rate is rejected");
}
const missingDuration = await execute("missing-duration", { spec: "{}", animate: true });
assert.match(missingDuration.content[0].text, /duration/, "animation requires a positive duration");

// Playback uses monotonic elapsed time; cached frame bytes survive source removal.
const originalNow = performance.now;
let now = 10_000;
Object.defineProperty(performance, "now", { configurable: true, value: () => now });
const timed = await execute("elapsed", {
  name: "elapsed",
  spec: JSON.stringify({ duration: 400, nodes: [] }),
  animate: true,
  fps: 10,
});
const theme = { fg: (_color, text) => text };
let invalidations = 0;
const renderContext = { toolCallId: "elapsed", invalidate: () => { invalidations += 1; } };
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
setCellDimensions({ widthPx: 10, heightPx: 20 });
const firstComponent = tool.renderResult(timed, {}, theme, renderContext);
const firstLines = firstComponent.render(120);
const firstMeta = kittyMetadata(firstLines[0]);
assert.equal(firstMeta.columns, 118, "image width follows the host render width");
rmSync(timed.details.frames[0]);
const cachedComponent = tool.renderResult(timed, {}, theme, renderContext);
assert.doesNotThrow(() => cachedComponent.render(160), "cached bytes avoid rereading a removed frame");
const cachedMeta = kittyMetadata(cachedComponent.render(160)[0]);
assert.equal(cachedMeta.columns, 158, "wider hosts are not capped at 84 columns");
assert.notEqual(cachedMeta.imageId, firstMeta.imageId, "redraws retain changing kitty image identities");
now += 200;
const halfwayComponent = tool.renderResult(timed, {}, theme, renderContext);
const halfwayLines = halfwayComponent.render(120);
const expectedHalfway = readFileSync(timed.details.frames[2]).toString("base64");
assert.ok(halfwayLines[0].includes(expectedHalfway), "elapsed half-loop selects the halfway frame independent of tick count");
assert.throws(() => tool.renderResult(timed, {}, theme, { ...renderContext, showImages: false }), /hidden/, "host image hiding stops custom animation");

// A frame larger than the total byte budget is not retained indefinitely.
const oversized = await execute("oversized", {
  name: "oversized",
  spec: JSON.stringify({ duration: 1000, framePadding: 256, nodes: [] }),
  animate: true,
  fps: 2,
});
now += 1000;
const oversizedContext = { toolCallId: "oversized", invalidate: () => {} };
const oversizedFirst = tool.renderResult(oversized, {}, theme, oversizedContext);
oversizedFirst.render(100);
rmSync(oversized.details.frames[0]);
rmSync(oversized.details.png);
assert.throws(
  () => tool.renderResult(oversized, {}, theme, oversizedContext),
  /ENOENT/,
  "oversized frame bytes are not kept beyond the cache budget",
);

const shutdown = registrations.events.get("session_shutdown");
const duringShutdown = execute("shutdown-active", { spec: JSON.stringify({ delayMs: 5000, nodes: [] }), animate: false });
const activeCancellation = assert.rejects(duringShutdown, (error) => error?.name === "AbortError", "shutdown cancels in-flight rendering");
await new Promise((resolve) => setTimeout(resolve, 20));
await shutdown({ type: "session_shutdown", reason: "quit" }, {});
await activeCancellation;
const invalidationsAfterShutdown = invalidations;
await new Promise((resolve) => setTimeout(resolve, 70));
assert.equal(invalidations, invalidationsAfterShutdown, "shutdown stops playback invalidations");
assert.equal(existsSync(animated.details.frames[0]), false, "shutdown removes owned temporary frame exports");

Object.defineProperty(performance, "now", { configurable: true, value: originalNow });

if (liveEngine) {
  process.env.DYNAMIC_DIAGRAM_BIN = liveEngine;
  const realSpec = JSON.stringify({ duration: 1000, canvas: { scale: 2 }, layout: "flow", nodes: [{ id: "a", icon: "dns", label: "Gateway" }, { id: "b", icon: "database", label: "Store" }], links: [{ from: "a", to: "b" }] });
  const realStatic = await execute("real-static", { name: "real-static", spec: realSpec });
  assert.equal(realStatic.content[0].type, "image", "real engine static export succeeds");
  const realAnimated = await execute("real-animated", { name: "real-animated", spec: realSpec, animate: true, fps: 2 });
  assert.equal(realAnimated.details.frames.length, 2, "real engine exports requested frame count");
  assert.equal(realAnimated.details.durationMs, 1000, "real engine period is preserved");
  assert.ok(realAnimated.details.frames[0].endsWith("00001.png"), "real engine manifest paths are used");
  const png = readFileSync(realAnimated.details.png);
  assert.equal(png.readUInt32BE(16), 3040, "canvas scale and density remain independent (760 * 2 * 2)");
  assert.deepEqual(realAnimated.content.map((part) => part.type), ["text"], "real animation has a single custom image renderer");
  const realComponent = tool.renderResult(realAnimated, {}, theme, { toolCallId: "real-animated", invalidate: () => {} });
  assert.equal(kittyMetadata(realComponent.render(130)[0]).columns, 128, "real image adapts to terminal width");
  await shutdown({ type: "session_shutdown", reason: "quit" }, {});
  console.log("live engine ok: static PNG, manifest frames, 2x presentation, adaptive width");
}
rmSync(sandbox, { recursive: true, force: true });
console.log("smoke ok: async rendering, adaptive playback, bounded cache, cancellation, and cleanup");
