/**
 * pi-diagram — LLM-driven dynamic diagram rendering for pi.
 *
 * The LLM calls the `diagram` tool with a declarative spec (nodes, icons,
 * links, arrows, packets). Rendering happens in a short-lived child process
 * (the `dynamic-diagram` Rust binary). Inline frame bytes use a bounded cache.
 *
 * Saved specs/posters land in <cwd>/.diagrams/<name>.{json,png}.
 * Commands: /diagram <name> (fullscreen view).
 *
 * Engine resolution: DYNAMIC_DIAGRAM_BIN → vendor/bin (postinstall downloads
 * a prebuilt binary from GitHub Releases) → PATH.
 * Manual install: cargo binstall dynamic-diagram (or cargo build --release).
 *
 * NOTE: inline animations need pi's fullscreen TUI mode
 * ("tuiMode": "fullscreen" in ~/.pi/agent/settings.json) — pi's regular
 * mode erases terminal scrollback on every animation tick.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Image } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = ".diagrams";
const DEFAULT_FPS = 24;
const MAX_FRAMES = 240;
const MAX_ANIMS = 12;
const RENDER_TIMEOUT_MS = positiveEnv("DD_DIAGRAM_TIMEOUT_MS", 30_000);
const ANIMATION_TIMEOUT_MS = positiveEnv("DD_ANIM_TIMEOUT_MS", 60_000);
const FRAME_CACHE_BUDGET = positiveEnv("DD_ANIM_CACHE_BYTES", 16 << 20);
const ANIMATION_DENSITY = positiveEnv("DD_ANIM_SCALE", 2);

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function bin(): string {
  if (process.env.DYNAMIC_DIAGRAM_BIN) return process.env.DYNAMIC_DIAGRAM_BIN;
  // postinstall drops a prebuilt engine here; otherwise fall back to PATH
  const vendored = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "vendor",
    "bin",
    process.platform === "win32" ? "dynamic-diagram.exe" : "dynamic-diagram",
  );
  return existsSync(vendored) ? vendored : "dynamic-diagram";
}

type ChildResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function abortError(): Error {
  const error = new Error("diagram rendering cancelled");
  error.name = "AbortError";
  return error;
}

/** Spawn the engine without blocking pi's renderer or input loop. */
function runEngine(
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number; maxBuffer?: number },
): Promise<ChildResult> {
  return new Promise((resolveResult, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }

    let child;
    try {
      child = spawn(bin(), args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }

    const limit = options.maxBuffer ?? (4 << 20);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= limit) return current;
      return current + chunk.toString("utf8", 0, Math.max(0, limit - Buffer.byteLength(current)));
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill();
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
      killTimer.unref();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) reject(abortError());
      else reject(error);
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(abortError());
        return;
      }
      if (timedOut) stderr = `engine timed out after ${options.timeoutMs}ms${stderr ? `: ${stderr}` : ""}`;
      resolveResult({ status, stdout, stderr, timedOut });
    });
  });
}

class FrameCache {
  private entries = new Map<string, { data: string; bytes: number }>();
  private totalBytes = 0;

  get(path: string): string {
    const cached = this.entries.get(path);
    if (cached) {
      this.entries.delete(path);
      this.entries.set(path, cached);
      return cached.data;
    }
    const data = readFileSync(path).toString("base64");
    this.put(path, data);
    return data;
  }

  async prime(paths: string[], signal: AbortSignal): Promise<void> {
    for (const path of paths) {
      signal.throwIfAborted();
      const data = (await readFile(path, { signal })).toString("base64");
      const bytes = Buffer.byteLength(data, "ascii");
      // Preserve a useful contiguous working set instead of reading every file
      // only to evict it before playback starts.
      if (bytes > FRAME_CACHE_BUDGET || this.totalBytes + bytes > FRAME_CACHE_BUDGET) break;
      this.put(path, data);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private put(path: string, data: string): void {
    const bytes = Buffer.byteLength(data, "ascii");
    if (bytes > FRAME_CACHE_BUDGET) return;
    const existing = this.entries.get(path);
    if (existing) this.totalBytes -= existing.bytes;
    this.entries.delete(path);
    while (this.totalBytes + bytes > FRAME_CACHE_BUDGET && this.entries.size) {
      const oldest = this.entries.keys().next().value as string;
      this.totalBytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(path, { data, bytes });
    this.totalBytes += bytes;
  }
}

class AdaptiveImage {
  private image: Image | undefined;
  private renderedWidth = -1;

  private readonly data: string;
  private readonly theme: ConstructorParameters<typeof Image>[2];
  private readonly filename: string;
  private readonly onRender: () => void;
  private readonly displayScale: number;

  constructor(data: string, theme: ConstructorParameters<typeof Image>[2], filename: string, displayScale: number, onRender = () => {}) {
    this.data = data;
    this.theme = theme;
    this.filename = filename;
    this.onRender = onRender;
    this.displayScale = displayScale;
  }

  render(width: number): string[] {
    this.onRender();
    if (!this.image || this.renderedWidth !== width) {
      this.renderedWidth = width;
      this.image = new Image(this.data, "image/png", this.theme, {
        filename: this.filename,
        maxWidthCells: Math.max(1, Math.floor((width - 2) * Math.min(1, this.displayScale))),
      });
    }
    return this.image.render(width);
  }

  invalidate(): void {
    this.image?.invalidate();
  }
}

type Playback = {
  durationMs: number;
  frames: string[];
  invalidate: () => void;
  lastRenderedAt: number;
  nextRefreshAt: number;
  refreshMs: number;
  startedAt: number;
};

const FRAME_CACHE = new FrameCache();
const ANIMS = new Map<string, Playback>();
const OWNED_FRAME_DIRS = new Set<string>();
let playbackTimer: ReturnType<typeof setTimeout> | undefined;

let playbackDueAt = Infinity;
const ACTIVE_JOBS = new Map<AbortController, Promise<DiagramResult>>();

function ensurePlaybackTimer(): void {
  const now = performance.now();
  const active = [...ANIMS.values()].filter((state) =>
    now - state.lastRenderedAt <= Math.max(1_000, state.refreshMs * 3));
  if (!active.length) return;
  const dueAt = Math.max(now + 1, Math.min(...active.map((state) => state.nextRefreshAt)));
  if (playbackTimer && playbackDueAt <= dueAt) return;
  if (playbackTimer) clearTimeout(playbackTimer);
  playbackDueAt = dueAt;
  playbackTimer = setTimeout(() => {
    playbackTimer = undefined;
    playbackDueAt = Infinity;
    const tick = performance.now();
    for (const state of ANIMS.values()) {
      if (tick - state.lastRenderedAt > Math.max(1_000, state.refreshMs * 3)) continue;
      if (tick >= state.nextRefreshAt) {
        state.nextRefreshAt = tick + state.refreshMs;
        state.invalidate();
      }
    }
    ensurePlaybackTimer();
  }, dueAt - now);
  playbackTimer.unref();
}

async function cleanupPlayback(): Promise<void> {
  for (const controller of ACTIVE_JOBS.keys()) controller.abort(abortError());
  await Promise.allSettled([...ACTIVE_JOBS.values()]);
  if (playbackTimer) clearTimeout(playbackTimer);
  playbackTimer = undefined;
  playbackDueAt = Infinity;
  ANIMS.clear();
  FRAME_CACHE.clear();
  for (const dir of OWNED_FRAME_DIRS) rmSync(dir, { recursive: true, force: true });
  OWNED_FRAME_DIRS.clear();
}

type DiagramParams = { search_icons?: string; name?: string; spec?: string; animate?: boolean; fps?: number };
type DiagramDetails = { png?: string; jsonPath?: string; frames?: string[]; durationMs?: number; msPerFrame?: number; displayScale?: number };
type DiagramResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" })[];
  details: DiagramDetails;
  isError?: boolean;
};

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function executeDiagram(params: DiagramParams, signal: AbortSignal, cwd: string): Promise<DiagramResult> {
  let workDir: string | undefined;
  let retainFrames = false;
  try {
    signal.throwIfAborted();
    if (params.search_icons) {
      const r = await runEngine(["spec", "--list-icons"], { signal, timeoutMs: RENDER_TIMEOUT_MS });
      if (r.status !== 0 || r.timedOut) throw new Error(r.stderr || "icon search failed");
      const q = params.search_icons.toLowerCase();
      const hits = r.stdout.split("\n").filter((name) => name.toLowerCase().includes(q)).slice(0, 80);
      return {
        content: [{ type: "text", text: `icon names matching "${params.search_icons}" (${hits.length} shown):\n${hits.join("\n")}` }],
        details: {},
      };
    }
    if (!params.spec) throw new Error("provide spec (JSON string) or search_icons");
    let parsed;
    try { parsed = JSON.parse(params.spec); }
    catch (error) { throw new Error(`spec is not valid JSON: ${error}`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("spec must be a JSON object");
    const duration = parsed.duration;
    const fps = params.fps ?? DEFAULT_FPS;
    if (params.animate) {
      if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('spec needs a positive integer "duration" (ms) to animate');
      if (!Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error("fps must be greater than 0 and at most 120");
    }
    const name = (params.name || "diagram").replace(/[^a-z0-9-_]/gi, "-");
    const dir = resolve(cwd, DIR);
    const jsonPath = join(dir, `${name}.json`);
    const png = join(dir, `${name}.png`);
    // Each invocation gets private input/output files so concurrent named renders
    // cannot change another child process's input while it is starting.
    workDir = await mkdtemp(join(tmpdir(), "pi-diagram-"));
    OWNED_FRAME_DIRS.add(workDir);
    const inputPath = join(workDir, "spec.json");
    await writeFile(inputPath, JSON.stringify(parsed, null, 2), { signal });
    let frames: string[] = [];
    let displayScale = 1;
    if (params.animate) {
      const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(duration * fps / 1000)));
      const frameDir = join(workDir, "frames");
      const r = await runEngine(["spec", inputPath, "frames", frameDir, String(count), "--density", String(ANIMATION_DENSITY)], { signal, timeoutMs: ANIMATION_TIMEOUT_MS });
      if (r.status !== 0 || r.timedOut) throw new Error(r.stderr || "animation export failed");
      const manifest = JSON.parse(await readFile(join(frameDir, "frames.json"), { encoding: "utf8", signal }));
      if (manifest.count !== count || manifest.duration !== duration || !Array.isArray(manifest.files) || manifest.files.length !== count ||
          !manifest.files.every((file: unknown) => typeof file === "string" && /^[0-9]+\.png$/.test(file))) {
        throw new Error("engine returned an invalid frame manifest");
      }
      frames = manifest.files.map((file: string) => join(frameDir, file));
      // The engine owns the presentation baseline; old manifests keep their
      // original full-width behavior. Raster density never controls cell size.
      if (Number.isFinite(manifest.display_scale) && manifest.display_scale > 0) {
        displayScale = manifest.display_scale;
      }
      await FRAME_CACHE.prime(frames, signal);
    } else {
      const r = await runEngine(["spec", inputPath], { signal, timeoutMs: RENDER_TIMEOUT_MS });
      if (r.status !== 0 || r.timedOut) throw new Error(r.stderr || "render failed");
    }
    signal.throwIfAborted();
    await mkdir(dir, { recursive: true });
    await copyFile(inputPath, jsonPath);
    await copyFile(frames[0] ?? join(workDir, "spec.png"), png);
    signal.throwIfAborted();
    if (frames.length >= 2) {
      retainFrames = true;
      return {
        content: [{ type: "text", text: `animation: /diagram ${name} · spec ${jsonPath}` }],
        details: { png, jsonPath, frames, durationMs: duration, msPerFrame: duration / frames.length, displayScale },
      };
    }
    const b64 = (await readFile(png, { signal })).toString("base64");
    const svgCmd = `${shellQuote(bin())} spec ${shellQuote(jsonPath)} svg > ${shellQuote(join(dir, `${name}.svg`))}`;
    return {
      content: [
        { type: "image", data: b64, mimeType: "image/png" },
        { type: "text", text: `rendered ${png} · spec ${jsonPath} · replay: /diagram ${name} · svg: ${svgCmd}` },
      ],
      details: { png, jsonPath },
    };
  } catch (error) {
    if (signal.aborted || (error as Error)?.name === "AbortError") throw abortError();
    return { content: [{ type: "text", text: `diagram failed: ${error}\n(engine: ${bin()}; set DYNAMIC_DIAGRAM_BIN or install dynamic-diagram on PATH)` }], details: {}, isError: true };
  } finally {
    if (workDir && !retainFrames) {
      OWNED_FRAME_DIRS.delete(workDir);
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

const SPEC_DOC = `Render an architecture/flow/runtime diagram as a polished image (site-grade styling, 11k+ icons).

spec JSON shape:
{
  "header"?: "TOP BAR ·· RIGHT SIDE",          // ·· splits left/right
  "duration"?: 6000,                           // ms per loop; tool animate:true enables playback
  "canvas"?: { "width": 760, "min_height": 330, "scale": 1 },
  "layout"?: "flow" | "grid" | { "mode": "grid", "columns": 3 },
  "badge"?: "bottom-center text",
  "note"?: "bottom caption line",
  "nodes": [ { "id": "db", "label": "postgres", "icon": "database", "x": 85, "y": 50, "status"?: "5432", "lifeline"?: false } ],
  "links": [ { "from": "api", "to": "db", "arrow"?: "end"|"both" } ],
  "packets": [ { "label": "SELECT", "from": "api", "to": "db", "progress": 0.4, "faded"?: false } ],
  "texts": [ { "text": "dmz", "x": 50, "y": 20, "dim"?: true, "left"?: false } ]
}
Coordinates are 0-100 scene space. ids are referenced by links/packets.
For automatic node placement, set layout and omit x/y on every node. Without layout, provide both x/y for each node (fixed coordinates). Measured labels/statuses determine node bounds and content height; captions follow the content.
canvas.min_height requests more scene room; canvas.scale multiplies the engine's 75% presentation baseline (2 doubles the new default) independently of PNG raster density. Terminal animation applies the engine's presentation factor within available host columns; pi's native static-image viewer controls its own fitting.
Static output is the default, even when duration exists. For inline playback call the tool with animate:true and optional fps (default 24, at most 120). At most 240 frames are generated; the authored loop duration is preserved.
Animated: give "duration" (ms), then prefer an "anim" verb over hand-written windows — picking a choreography is as cheap as picking an icon:
- "anim": "seq" — strict relay, one packet at a time (pipelines, handshakes)
- "anim": "fanout" — first half of the packet list flies out, second half flies back (fan-out/fan-in, request/response)
- "anim": "flood" — all packets simultaneously (broadcasts)
- "anim": "flip" — node statuses reveal in node order (state-machine stories)
Custom timing: per-packet "window": [start, end] loop fractions (0..1), e.g. [0.02, 0.26]; full escape hatch is keyframe timelines.

icon tiers (use search_icons to discover):
- Material Symbols (3912): router, dns, cloud, storage, security, laptop, cell_tower, factory...
- cloud officials (full color, namespaced): aws/..., azure/..., gcp/..., cf/... + aliases: ec2, s3, lambda, dynamodb, sqs, sns, iam, vpc, cloudfront, route53, azure_vm, bigquery, cloud_run, gce, cloudflare, workers, r2
- Tabler (5130, stroke style): prefix ti/ — ti/stack-2, ti/list-check, ti/cpu, ti/topology-star, ti/hierarchy, ti/container...
- flowchart shapes: box, cylinder, ellipse, diamond, hexagon, stadium, triangle, subroutine
- aliases: server→dns, phone/client→smartphone, tower→cell_tower, firewall→security, database/db→storage, globe→public`;

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", cleanupPlayback);
  pi.registerTool({
    name: "diagram",
    label: "Diagram",
    description: SPEC_DOC,
    promptSnippet: "Render architecture/flow diagrams as images from a declarative spec",
    promptGuidelines: [
      "Use diagram whenever a visual would clarify architecture, data flow, or runtime state. Rendering runs asynchronously in a child process.",
      "Call diagram with search_icons first when unsure an icon name exists.",
    ],
    parameters: Type.Object({
      search_icons: Type.Optional(Type.String({ description: "substring to search 11k+ icon names; returns matches instead of rendering" })),
      name: Type.Optional(Type.String({ description: "slug for output files (default: diagram)" })),
      spec: Type.Optional(Type.String({ description: "the spec JSON document as a string" })),
      animate: Type.Optional(Type.Boolean({ description: "enable inline playback; requires a positive spec duration; omitted or false renders a static image" })),
      fps: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 120, description: "requested animation frames per second, default 24; generation caps at 240 frames while preserving loop duration" })),
    }),
    // pi adds image content blocks independently of custom renderResult output.
    // Animated results therefore carry text only; static results use its native path.
    renderResult(result, _options, theme, context) {
      const frames = result?.details?.frames ?? [];
      const key = context.toolCallId ?? String(result?.details?.png ?? "diagram");
      if (context.showImages === false) {
        ANIMS.delete(key);
        throw new Error("images hidden: use default text rendering");
      }
      if (frames.length < 2) throw new Error("static result: use default rendering");
      const now = performance.now();
      let anim = ANIMS.get(key);
      if (!anim || anim.frames !== frames) {
        const durationMs = Number(result.details.durationMs) || Number(result.details.msPerFrame) * frames.length || 140 * frames.length;
        const refreshMs = Math.max(1000 / 120, durationMs / frames.length);
        anim = { frames, durationMs, refreshMs, startedAt: now, nextRefreshAt: now + refreshMs, lastRenderedAt: -Infinity, invalidate: context.invalidate };
        ANIMS.set(key, anim);
        if (ANIMS.size > MAX_ANIMS) ANIMS.delete(ANIMS.keys().next().value as string);
      }
      anim.invalidate = context.invalidate;
      const index = Math.floor(((now - anim.startedAt) % anim.durationMs) / anim.durationMs * frames.length);
      const imageTheme = { fallbackColor: (text: string) => theme.fg("toolOutput", text) };
      const displayScale = Number.isFinite(result.details.displayScale) && result.details.displayScale > 0
        ? result.details.displayScale : 1;
      let data;
      try { data = FRAME_CACHE.get(frames[index]); }
      catch (error) {
        ANIMS.delete(key);
        // Saved transcript rows can outlive their session's temporary frames.
        if (!result.details.png) throw error;
        return new AdaptiveImage(readFileSync(result.details.png).toString("base64"), imageTheme, result.details.png, displayScale);
      }
      const state = anim;
      return new AdaptiveImage(data, imageTheme, frames[index], displayScale, () => {
        if (ANIMS.get(key) !== state) return;
        state.lastRenderedAt = performance.now();
        ensurePlaybackTimer();
      });
    },

    async execute(_id, params, signal, _upd, ctx) {
      const controller = new AbortController();
      const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const job = executeDiagram(params, combinedSignal, ctx.cwd);
      ACTIVE_JOBS.set(controller, job);
      try { return await job; }
      finally { ACTIVE_JOBS.delete(controller); }
    },
  });

  pi.registerCommand("diagram", {
    description: "View rendered diagrams: /diagram [name] lists or shows commands",
    handler: async (args, ctx) => {
      const dir = resolve(ctx.cwd, DIR);
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      if (!args) {
        ctx.ui.notify(files.length ? `diagrams: ${files.map((f) => f.replace(".json", "")).join(", ")} — /diagram <name> to view` : "no diagrams yet (ask the LLM to use the diagram tool)", "info");
        return;
      }
      const jsonPath = join(dir, `${args}.json`);
      // fullscreen takeover: pause the TUI, let the child own the terminal
      // (image display, or full animation), then restore pi.
      await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
        tui.stop();
        // show the image, hold until any key, then restore pi
        const shell = process.env.SHELL || "/bin/sh";
        const script = `${shellQuote(bin())} spec ${shellQuote(jsonPath)} kitty; read -n 1 -s -r -p "press any key to return"`;
        const r = spawnSync(shell, ["-c", script], { stdio: "inherit", timeout: 300_000 });
        done(r.status ?? 0);
        return undefined as never;
      });
    },
  });
}
