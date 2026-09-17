# pi-diagram

pi extension that renders **architecture / data-flow / runtime diagrams inline
in the transcript**, from a declarative JSON spec the LLM writes.

Built on the [dynamic-diagram](../dynamic-diagram) engine: rendering runs in a
short-lived child process (~15ms, peak 10–25MB in the child, freed on exit) —
pi's own memory is never affected.

## What it adds to pi

- **`diagram` tool** — the LLM writes a JSON spec (nodes, icons, links, flying
  packets), the tool renders a site-grade image inline. `search_icons` param
  searches the 11,831-icon catalog.
- **`/diagram [name]`** — list rendered diagrams; `/diagram <name>` opens one
  fullscreen (kitty-protocol image).
- **`/anim [sim]`** — fullscreen player for the engine's 28 built-in network
  animations (tcp handshake, tls, dns, quic, bgp, …).
- **Inline animation** — specs with `"duration": ms` animate directly in the
  transcript (12-frame loop cycling).

## Requirements

- The engine binary, either on `PATH` or via env:
  ```sh
  cd dynamic-diagram && cargo build --release
  export DYNAMIC_DIAGRAM_BIN=$PWD/target/release/dynamic-diagram
  # or: ln -s $PWD/target/release/dynamic-diagram ~/.local/bin/
  ```

> **Inline animations need pi's fullscreen TUI mode.** Set
> `"tuiMode": "fullscreen"` in `~/.pi/agent/settings.json` (or start with
> `pi --tui-mode fullscreen`). In pi's default `regular` mode every animation
> tick triggers a full repaint that emits `ESC[3J` (ED3), erasing the
> terminal's scrollback and pinning the view to the bottom — scrolling becomes
> impossible while playing. In fullscreen mode the transcript is a real
> ScrollView with follow-suppression: manual scroll disables auto-follow and
> scrolling stays alive during playback.

## Install

As a pi package (from a checkout):

```sh
pi install /path/to/pi-diagram
```

Or for development (hot-reloadable with `/reload`):

```sh
ln -s /path/to/pi-diagram/extensions/index.ts ~/.pi/agent/extensions/pi-diagram.ts
```

## Env

| var | meaning |
|-----|---------|
| `DYNAMIC_DIAGRAM_BIN` | path to the engine binary (default: `dynamic-diagram` from `PATH`) |
| `DD_ANIM_SCALE` | animation frame raster scale, default `2` (static PNGs render at 3) |

Output files land in `<cwd>/.diagrams/<name>.{json,png,svg}` and
`<cwd>/.diagrams/<name>.frames/`.

## Test

```sh
npm test   # loads the extension against a mock ExtensionAPI, asserts registrations
```

The spec format is documented in the tool description itself; the full
reference and an authoring skill for AI agents live in the
[dynamic-diagram](../dynamic-diagram) repo (`docs/SPEC.md`,
`skills/dynamic-diagram/SKILL.md`).
