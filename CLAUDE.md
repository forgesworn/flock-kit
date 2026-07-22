# CLAUDE.md — flock-kit

Framework-free location-safety and trusted-circle protocol primitives for ForgeSworn applications.

## Commands

- `npm run build` — compile TypeScript to dist/
- `npm test` — run all tests (vitest: `src/**/*.test.ts` + `compatibility/**/*.test.ts`)
- `npm run test:watch` — watch mode
- `npm run test:coverage` — coverage via v8 (80% gate: statements/branches/functions/lines)
- `npm run typecheck` — type-check without emitting
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm run smoke` — build, then round-trip a signed/encrypted signal in-process (`scripts/smoke.mjs`)
- `npm run check:extraction` — verify `src/` + compatibility vectors match the extraction-manifest digest
- `npm run gen:vectors` — regenerate `compatibility/v1/radar-vectors.json` (`FLOCK_GEN_VECTORS=1`, deliberate changes only)

## Structure

- `src/` — pure protocol/policy modules (see Exports below), each with a co-located `*.test.ts`
- `src/coordination.ts` — fixed human-to-human vocabulary used by `buzz` (root barrel only, no subpath export)
- `src/index.ts` — barrel re-export of every flock module plus the full `canary-kit` + `canary-kit/nostr` surface
- `compatibility/v1/` — golden-vector native-parity harness: module→test manifest, frozen protocol + radar vectors, extraction digest
- `scripts/` — `check-extraction.mjs`, `smoke.mjs`
- `FLOCK.md` — protocol specification; `SECURITY.md` — vulnerability reporting

## Exports

- `@forgesworn/flock` — full API: every module below, plus the complete `canary-kit` + `canary-kit/nostr` surface
- `@forgesworn/flock/geofence`, `/noreport`, `/policy`, `/signals` — core protocol
- `@forgesworn/flock/nightout`, `/checkin`, `/trail` — circle state and safety
- `@forgesworn/flock/buzz`, `/allclear`, `/joined`, `/disband`, `/lost`, `/findping` — circle pings and lifecycle
- `@forgesworn/flock/fences`, `/rendezvous`, `/meeting`, `/offgrid`, `/spokenverify`, `/radar`, `/radarSession` — location-sharing, meeting and locked-phone guidance

`coordination` (the fixed vocabulary `buzz` renders) is exported from the root import only — it has no dedicated subpath.

## Conventions

- **British English** — licence, colour, centre, behaviour
- **Pure core** — `src/` modules are deterministic: no I/O, no `Date.now()`, no mutation. "Now" and positions are caller-supplied inputs; geohash encoding and encryption happen at the edge (the consuming app), not in this library
- **Real runtime dependencies** — `canary-kit` (groups, beacons, duress, gift-wrap building blocks) and `geohash-kit` (geo maths); this package is not zero-dependency
- **ESM-only** — `"type": "module"`, Node ≥ 24
- **TDD** — write failing test first, then implement
- **Golden-vector parity** — `radar`/`radarSession` guidance is mirrored by a native Kotlin implementation; `compatibility/v1/radar-vectors.json` is the frozen cross-language contract. Regenerate only for an intentional rule change (`npm run gen:vectors`) and review the diff — never hand-edit it
- **Git:** commit messages use `type: description` format
- **Git:** Do NOT include `Co-Authored-By` lines in commits

## Release & Versioning

No release has been published to npm yet (`@forgesworn/flock` 404s on the
registry). `package.json` is publish-ready — public, `publishConfig.provenance:
true` — but `.github/workflows/ci.yml` only lints, tests, type-checks, builds,
smoke-tests and dry-run-packs on push/PR to `main`; there's no automated
release or publish workflow (no `forgesworn/anvil` here). Only `v0.1.0` is
tagged in git — the 0.2.0 version bump wasn't — so treat tagging as a
deliberate per-release step, not an enforced one.

Until a package is published, consumers pin an immutable Git commit:

```json
{ "dependencies": { "@forgesworn/flock": "git+https://github.com/forgesworn/flock-kit.git#<commit-sha>" } }
```

Release flow, when cutting one (manual — no anvil):

1. Bump `package.json` version by hand and add a `CHANGELOG.md` entry
2. Run the `prepublishOnly` gate yourself: `check:extraction`, `test`, `typecheck`, `build`, `smoke`
3. Commit (`chore: release x.y.z`), push `main`, tag `vx.y.z`
4. `npm publish` — provenance needs a supported CI/OIDC environment, not a bare local publish

Semver, as actually practised here (pre-1.0 — CHANGELOG's 0.1.0 → 0.2.0 carried a breaking `buzz` payload change as a MINOR bump):

| Change | Bump |
|---|---|
| Bug fix, no API change | Patch (0.2.x) |
| New feature or breaking API change, pre-1.0 | Minor (0.x.0) |
| Tooling, docs, refactor with no behaviour change | Patch or none |
| Breaking change once ≥ 1.0.0 | Major (x.0.0) |
