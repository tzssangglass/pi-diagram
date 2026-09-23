/**
 * postinstall: fetch the dynamic-diagram engine binary from GitHub Releases
 * into vendor/bin/. Runtime resolution order:
 * DYNAMIC_DIAGRAM_BIN → vendor/bin (this script) → PATH.
 *
 * Skip with PI_DIAGRAM_SKIP_DOWNLOAD=1. Never fails the install: on any error
 * it warns and exits 0 so the engine can be installed manually later.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";

const ENGINE_VERSION = "0.2.2"; // engine release tag to fetch; bump when the engine releases
const REPO = "tzssangglass/dynamic-diagram";
// dynamic-diagram release signing key (signing.pub in the engine repo)
const MINISIGN_PUBKEY = "RWQH1BCw/M2EcXI5QIwhjjTou5lMmXyB+hoQ9qlRLr5kuekgWjCAWaRw";

const TRIPLES = {
  "linux:x64": "x86_64-unknown-linux-musl",
  "linux:arm64": "aarch64-unknown-linux-musl",
  "darwin:x64": "x86_64-apple-darwin",
  "darwin:arm64": "aarch64-apple-darwin",
  "win32:x64": "x86_64-pc-windows-msvc",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

main().catch((err) => {
  warn(`engine download failed: ${err.message}`);
  warn("install the engine manually (cargo binstall dynamic-diagram) or set DYNAMIC_DIAGRAM_BIN");
  process.exit(0); // postinstall must not break npm install
});

async function main() {
  if (process.env.PI_DIAGRAM_SKIP_DOWNLOAD) return note("skipped (PI_DIAGRAM_SKIP_DOWNLOAD)");
  const triple = TRIPLES[`${process.platform}:${process.arch}`];
  if (!triple) return note(`no prebuilt engine for ${process.platform}/${process.arch}; install manually`);
  const isWin = process.platform === "win32";
  const binName = isWin ? "dynamic-diagram.exe" : "dynamic-diagram";
  const destDir = join(root, "vendor", "bin");
  const dest = join(destDir, binName);
  if (existsSync(dest)) return note(`engine already at ${dest}`);

  const archive = `dynamic-diagram-${triple}.${isWin ? "zip" : "tar.gz"}`;
  const base = process.env.PI_DIAGRAM_ENGINE_BASE_URL ??
    `https://github.com/${REPO}/releases/download/v${ENGINE_VERSION}`;
  const tmp = mkdtempSync(join(tmpdir(), "pi-diagram-"));
  try {
    const archivePath = join(tmp, archive);
    writeFileSync(archivePath, await get(`${base}/${archive}`));
    // minisign signature (pure Ed25519, "Ed" blob) — supply-chain verification
    const sigText = (await get(`${base}/${archive}.sig`)).toString("utf8");
    if (!verifyMinisign(sigText, readFileSync(archivePath))) {
      throw new Error(`signature verification failed for ${archive}`);
    }
    // tar(1) everywhere: bsdtar on Windows/macOS, GNU tar on Linux — all read tar.gz, bsdtar also zip.
    // cargo-dist archives root every file under a "{name}-{target}/" directory.
    const member = `dynamic-diagram-${triple}/${binName}`;
    execFileSync("tar", ["-xf", join(tmp, archive), "-C", tmp, member], { stdio: "pipe" });
    mkdirSync(destDir, { recursive: true });
    copyFileSync(join(tmp, member), dest);
    if (!isWin) chmodSync(dest, 0o755);
    note(`engine v${ENGINE_VERSION} installed to ${dest}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function get(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Verify a minisign -l signature (Ed + 8-byte keynum + 64-byte Ed25519 sig). */
function verifyMinisign(sigText, data) {
  try {
    const blob = Buffer.from(sigText.split("\n")[1], "base64");
    if (blob.subarray(0, 2).toString() !== "Ed") return false;
    const sig = blob.subarray(10);
    const pk = Buffer.from(MINISIGN_PUBKEY, "base64").subarray(10);
    return ed25519.verify(sig, data, pk);
  } catch {
    return false;
  }
}

function note(msg) {
  console.log(`pi-diagram: ${msg}`);
}

function warn(msg) {
  console.warn(`pi-diagram: warning: ${msg}`);
}
