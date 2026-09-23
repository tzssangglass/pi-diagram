# pi-diagram — agent guide

pi extension rendering architecture/flow diagrams inline from declarative
JSON specs via the `dynamic-diagram` engine (sibling repo
`../dynamic-diagram`, public). Published as `@tzssangglass/pi-diagram`.

## Engine

Resolution order in `extensions/index.ts::bin()`:
`DYNAMIC_DIAGRAM_BIN` → vendored `vendor/bin` → PATH.
`scripts/postinstall.mjs` downloads a minisign-verified engine binary
(Ed25519 via `@noble/curves`, pubkey pinned in the script) from the engine
repo's GitHub Releases into `vendor/bin/`. Local-path installs skip npm
lifecycle scripts, so the vendored download only happens for npm/git
installs — locally the PATH engine (`cargo binstall dynamic-diagram`)
covers it.

## Test

```sh
npm test    # fake-engine smoke test
```
