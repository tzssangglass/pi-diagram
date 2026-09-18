/**
 * pi-diagram — LLM-driven dynamic diagram rendering for pi.
 *
 * The LLM calls the `diagram` tool with a declarative spec (nodes, icons,
 * links, arrows, packets). Rendering happens in a short-lived child process
 * (the `dynamic-diagram` Rust binary): ~15ms, peak ~10-25MB in the CHILD,
 * freed on exit — pi's own RSS is never affected.
 *
 * Output lands in <cwd>/.diagrams/<name>.{json,png,svg}.
 * Commands: /diagram <name> (fullscreen view) · /anim <sim> (28 sims).
 *
 * Requires the engine on PATH or DYNAMIC_DIAGRAM_BIN=/path/to/dynamic-diagram.
 * Build it from the dynamic-diagram repo: cargo build --release.
 *
 * NOTE: inline animations need pi's fullscreen TUI mode
 * ("tuiMode": "fullscreen" in ~/.pi/agent/settings.json) — pi's regular
 * mode erases terminal scrollback on every animation tick.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Image } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = ".diagrams";

// engine binary: DYNAMIC_DIAGRAM_BIN wins, then PATH lookup (cached)
let BIN_CACHE: string | null = null;
function bin(): string {
  if (BIN_CACHE) return BIN_CACHE;
  if (process.env.DYNAMIC_DIAGRAM_BIN) return (BIN_CACHE = process.env.DYNAMIC_DIAGRAM_BIN);
  const r = spawnSync("sh", ["-c", "command -v dynamic-diagram"], { encoding: "utf8" });
  const hit = r.stdout?.trim();
  if (hit) return (BIN_CACHE = hit);
  return "dynamic-diagram"; // fall through: spawnSync surfaces the ENOENT to the caller
}

// One animation timer per tool-result row, keyed by toolCallId: pi may recreate
// a row's component/rendererState, but this map lives in the process. Capped so
// old rows can't accumulate timers forever.
const ANIMS = new Map<string, { t: ReturnType<typeof setInterval>; idx: number }>();
const MAX_ANIMS = 12;

const SPEC_DOC = `Render an architecture/flow/runtime diagram as a polished image (site-grade styling, 11k+ icons).

spec JSON shape:
{
  "header"?: "TOP BAR ·· RIGHT SIDE",          // ·· splits left/right
  "duration"?: 6000,                           // ms per loop — presence enables animation
  "badge"?: "bottom-center text",
  "note"?: "bottom caption line",
  "nodes": [ { "id": "db", "label": "postgres", "icon": "database", "x": 85, "y": 50, "status"?: "5432", "lifeline"?: false } ],
  "links": [ { "from": "api", "to": "db", "arrow"?: "end"|"both" } ],
  "packets": [ { "label": "SELECT", "from": "api", "to": "db", "progress": 0.4, "faded"?: false } ],
  "texts": [ { "text": "dmz", "x": 50, "y": 20, "dim"?: true, "left"?: false } ]
}
Coordinates are 0-100 scene space. ids are referenced by links/packets.
Layout: keep icon nodes WITH a status badge at y <= 75 (icon+label+badge stack ~60 units; lower collides with the caption divider).
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

// global animation registry: at most ONE timer runs (latest diagram wins)

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "diagram",
    label: "Diagram",
    description: SPEC_DOC,
    promptSnippet: "Render architecture/flow diagrams as images from a declarative spec",
    promptGuidelines: [
      "Use diagram whenever a visual would clarify architecture, data flow, or runtime state — it renders in ~15ms via a child process.",
      "Call diagram with search_icons first when unsure an icon name exists.",
    ],
    parameters: Type.Object({
      search_icons: Type.Optional(Type.String({ description: "substring to search 11k+ icon names; returns matches instead of rendering" })),
      name: Type.Optional(Type.String({ description: "slug for output files (default: diagram)" })),
      spec: Type.Optional(Type.String({ description: "the spec JSON document as a string" })),
      animate: Type.Optional(Type.Boolean({ description: "spec must have duration; exports 12 loop frames and animates them INLINE in the transcript" })),
    }),
    // Inline animation: cycle pre-rendered frames forever, one timer per row.
    // Fresh Image per tick → fresh kitty imageId → the TUI diff re-renders
    // (a stable imageId makes the TUI treat the frame as unchanged).
    //
    // CRITICAL: pi wraps our return value in `new MouseRegion(component)` with
    // NO undefined check — returning undefined crashes the whole TUI on the next
    // render tick (MouseRegion.render → undefined.render). Throwing is pi's
    // designed escape hatch: the catch in updateDisplay() falls back to the
    // default text/image rendering. So: anything we don't animate → throw.
    renderResult(result, _options, theme, context) {
      const frames = result?.details?.frames ?? [];
      if (frames.length < 2) throw new Error("static result: use default rendering");
      const key = context.toolCallId ?? String(result?.details?.png ?? "diagram");
      let anim = ANIMS.get(key);
      if (!anim) {
        const ms = Number(result?.details?.msPerFrame) || 140; // real time: 1 lap = spec duration
        const a: { t: ReturnType<typeof setInterval>; idx: number } = { idx: 0, t: setInterval(() => {
          a.idx = (a.idx + 1) % frames.length;
          context.invalidate();
        }, ms) };
        ANIMS.set(key, a);
        if (ANIMS.size > MAX_ANIMS) {
          const oldest = ANIMS.keys().next().value as string;
          clearInterval(ANIMS.get(oldest)!.t);
          ANIMS.delete(oldest);
        }
        anim = a;
      }
      // if the frame file vanished → throw → pi's default rendering (text line)
      const b64 = readFileSync(frames[anim.idx % frames.length]).toString("base64");
      return new Image(b64, "image/png", theme, { maxWidthCells: 84 });
    },

    async execute(_id, params, _sig, _upd, ctx) {
      // icon search mode
      if (params.search_icons) {
        const r = spawnSync(bin(), ["spec", "--list-icons"], { encoding: "utf8", maxBuffer: 4 << 20 });
        if (r.status !== 0) return { content: [{ type: "text", text: `engine not found or failed: ${r.stderr}\nset DYNAMIC_DIAGRAM_BIN or install dynamic-diagram on PATH` }], details: {} };
        const q = params.search_icons.toLowerCase();
        const hits = r.stdout.split("\n").filter((n) => n.toLowerCase().includes(q)).slice(0, 80);
        return {
          content: [{ type: "text", text: `icon names matching "${params.search_icons}" (${hits.length} shown):\n${hits.join("\n")}` }],
          details: {},
        };
      }
      if (!params.spec) {
        return { content: [{ type: "text", text: "provide spec (JSON string) or search_icons" }], details: {} };
      }
      // validate JSON before spawning
      let parsed: unknown;
      try {
        parsed = JSON.parse(params.spec);
      } catch (e) {
        return { content: [{ type: "text", text: `spec is not valid JSON: ${e}` }], details: {} };
      }
      const name = (params.name || "diagram").replace(/[^a-z0-9-_]/gi, "-");
      const dir = resolve(ctx.cwd, DIR);
      mkdirSync(dir, { recursive: true });
      const jsonPath = join(dir, `${name}.json`);
      writeFileSync(jsonPath, JSON.stringify(parsed, null, 2));
      // render PNG in a child process — memory lives and dies with the child
      const r = spawnSync(bin(), ["spec", jsonPath], { encoding: "utf8", timeout: 30_000 });
      if (r.status !== 0) {
        return { content: [{ type: "text", text: `render failed: ${r.stderr || "unknown"}\n(engine: ${bin()})` }], details: {} };
      }
      const png = join(dir, `${name}.png`);
      const svgCmd = `${bin()} spec ${jsonPath} svg > ${join(dir, name)}.svg`;
      // image content block: pi renders it INLINE in the transcript natively
      let frames: string[] = [];
      let msPerFrame = 0;
      if (params.animate) {
        try {
          const duration = Number((parsed as { duration?: number }).duration);
          if (!duration) throw new Error('spec needs "duration" (ms) to animate');
          // frames at 2×: the TUI shows ~84 cells (≈1520px) wide, so 3× would
          // only add bytes — 136KB/frame + 3.8MB decoded vs 224KB + 8.6MB,
          // visually identical at display size. Static PNG stays at 3×.
          const fr = spawnSync(bin(), ["spec", jsonPath, "frames", join(dir, `${name}.frames`), "24"], {
            encoding: "utf8", timeout: 60_000,
            env: { ...process.env, DDA_SCALE: process.env.DD_ANIM_SCALE ?? "2" },
          });
          if (fr.status !== 0) throw new Error(fr.stderr?.slice(0, 200));
          frames = readdirSync(join(dir, `${name}.frames`)).filter((f) => f.endsWith(".png")).sort()
            .map((f) => join(dir, `${name}.frames`, f));
          msPerFrame = Math.max(60, Math.round(duration / Math.max(1, frames.length)));
        } catch (e) {
          return { content: [{ type: "text", text: `animation export failed: ${e}` }], details: { png, jsonPath } };
        }
      }
      if (frames.length >= 2) {
        // animated: NO image block (renderResult cycles frames). The built-in
        // path would render a static copy alongside → double image → misalign.
        return {
          content: [{ type: "text", text: `animation: /diagram ${name} · spec ${jsonPath}` }],
          details: { png, jsonPath, frames, msPerFrame },
        };
      }
      const b64 = readFileSync(png).toString("base64");
      return {
        content: [
          { type: "image", data: b64, mimeType: "image/png" },
          { type: "text", text: `rendered ${png} · spec ${jsonPath} · replay: /diagram ${name} · svg: ${svgCmd}` },
        ],
        details: { png, jsonPath },
      };
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
        const script = `${bin()} spec ${JSON.stringify(jsonPath)} kitty; read -n 1 -s -r -p "press any key to return"`;
        const r = spawnSync(shell, ["-c", script], { stdio: "inherit", timeout: 300_000 });
        done(r.status ?? 0);
        return undefined as never;
      });
    },
  });

  // /anim <sim> — fullscreen animation player (Ctrl+C returns to pi)
  pi.registerCommand("anim", {
    description: "Play a built-in animation fullscreen: /anim [tcphs|tls|dns|quic|...] (28 sims)",
    handler: async (args, _ctx) => {
      const sim = args || "tcphs";
      await _ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
        tui.stop();
        const r = spawnSync(bin(), ["kitty", sim], { stdio: "inherit", timeout: 600_000 });
        done(r.status ?? 0);
        return undefined as never;
      });
    },
  });
}
