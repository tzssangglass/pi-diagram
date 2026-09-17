// Smoke test: load the extension through its public seam (the default factory)
// against a mock ExtensionAPI and assert registrations + one execute path.
// Run: npm test  (needs node >= 23 for type stripping)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const registrations = { tools: [], commands: [] };
const pi = {
  registerTool: (t) => registrations.tools.push(t),
  registerCommand: (name, c) => registrations.commands.push({ name, ...c }),
  on: () => {},
};

const mod = await import(new URL("../extensions/index.ts", import.meta.url).href);
assert.equal(typeof mod.default, "function", "extension exports a default factory");

mod.default(pi);

const tool = registrations.tools.find((t) => t.name === "diagram");
assert.ok(tool, "diagram tool registered");
assert.ok(tool.description.length > 200, "tool description teaches the spec format");
assert.ok(tool.parameters, "tool has typebox parameters");
assert.ok(registrations.commands.some((c) => c.name === "diagram"), "/diagram command registered");
assert.ok(registrations.commands.some((c) => c.name === "anim"), "/anim command registered");

// behavior: search_icons always returns text content (even if engine missing)
const res = await tool.execute("t1", { search_icons: "dns" }, undefined, () => {}, { cwd: process.cwd() });
assert.ok(Array.isArray(res.content) && res.content[0].type === "text", "search_icons returns text content");

// if the engine is installed, the search must actually find icons
const which = spawnSync("sh", ["-c", "command -v dynamic-diagram"], { encoding: "utf8" });
if (which.stdout?.trim()) {
  assert.ok(res.content[0].text.includes("dns"), "engine on PATH: dns icon found");
}

console.log("smoke ok: diagram tool + /diagram + /anim registered, search_icons works");
