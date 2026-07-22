# AGENTS.md — flock-kit

Instructions in this file apply to the entire repository.

## Project Summary
- Framework-free, pure/deterministic location-safety and trusted-circle
  protocol primitives (`@forgesworn/flock`) for ForgeSworn applications —
  geofencing, disclosure policy, duress/check-in/trail signals, night-out
  presence, and locked-phone radar guidance.
- A thin application layer over `canary-kit` (which extends `spoken-token`):
  this library decides policy and builds inner events; the consuming app
  encodes geohashes, signs, encrypts, gift-wraps per recipient, and publishes
  the outer kind-1059 events.
- ESM-only package (`"type": "module"`).
- Requires Node.js 24+.

## Key Commands
- `npm run build` — compile TypeScript into `dist/`
- `npm test` — run the Vitest suite (`src/**/*.test.ts` + `compatibility/**/*.test.ts`)
- `npm run test:watch` — run tests in watch mode
- `npm run test:coverage` — run tests with v8 coverage (80% statements/branches/functions/lines gate)
- `npm run typecheck` — TypeScript type-check without emitting
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm run smoke` — build, then round-trip a signed/encrypted signal between two in-process parties
- `npm run check:extraction` — verify `src/` and the compatibility vectors haven't drifted from the commit this package was extracted from
- `npm run gen:vectors` — regenerate `compatibility/v1/radar-vectors.json` for a deliberate radar rule change (sets `FLOCK_GEN_VECTORS=1`)

## Repository Structure
- `src/` — pure modules, each with a co-located `*.test.ts`: `geofence`,
  `noreport`, `policy`, `signals` (core protocol); `nightout`, `checkin`,
  `trail` (circle state and safety); `buzz`, `allclear`, `joined`, `disband`,
  `lost`, `findping` (circle pings and lifecycle); `fences`, `rendezvous`,
  `meeting`, `offgrid`, `spokenverify`, `radar`, `radarSession`
  (location-sharing and locked-phone guidance); plus `coordination`
  (root-barrel-only, no subpath)
- `src/index.ts` — barrel re-export of every module above plus the full
  `canary-kit` + `canary-kit/nostr` surface
- `src/compatibility-manifest.test.ts`, `src/package-exports.test.ts` — fail
  the build if a public export is missing a source file, a focused test, or
  its `manifest.json` row
- `compatibility/v1/` — the golden-vector native-parity harness:
  `manifest.json` (module → test → contract map), `vectors.json` +
  `protocol-vectors.test.ts` (frozen key-derivation/encryption vectors),
  `radar-vectors.json` + `radar-generate.test.ts` (frozen radar guidance
  vectors, shared with the native Kotlin port), `extraction-manifest.json`
  (the digest `check-extraction.mjs` verifies against)
- `scripts/` — `check-extraction.mjs`, `smoke.mjs`
- `FLOCK.md` — protocol specification (event kinds, payload shapes, privacy invariants)
- `dist/` — build output (generated)

## Coding Conventions
- Use British English spelling in identifiers and prose: `licence`, `colour`, `centre`.
- Library modules are pure and deterministic — no I/O, no `Date.now()`, no
  mutation. "Now" and positions are always caller-supplied inputs; geohash
  encoding/decoding and encryption happen at the edge (the consuming app),
  never inside these modules.
- Preserve golden-vector parity: `radar`/`radarSession` guidance is mirrored
  by a native Kotlin implementation and pinned by
  `compatibility/v1/radar-vectors.json`. Never change guidance behaviour
  without deliberately regenerating and reviewing that vector diff.
- ESM-only; keep imports/exports ESM-compatible.
- Prefer TDD when changing behaviour: add or update a failing test first, then implement.
- ESLint enforces `import type` for type-only imports and forbids throwing
  non-`Error` values (`no-throw-literal`) — run `npm run lint` before committing.

## Working Guidelines
- Do not edit generated output in `dist/` by hand.
- Only regenerate `compatibility/v1/radar-vectors.json` (`npm run gen:vectors`)
  for an intentional rule change, and review the diff — never to silence a
  failing test. `vectors.json` (non-radar) was extracted with the source
  history and must not be regenerated at all.
- Run `npm run check:extraction` after touching anything under `src/` or
  `compatibility/v1/` — it guards the standalone package boundary against
  silent drift from the original extraction commit.
- Update `FLOCK.md` and the relevant module's doc comment when public API or
  wire behaviour changes.

## Release Notes
- Commits follow `type: description` (`feat:`, `fix:`, `docs:`, `chore:`,
  `test:`, …), but there is no `semantic-release`/anvil automation reading
  them — version bumps in `package.json` and `CHANGELOG.md` are manual.
- The package is pre-1.0: a breaking change (e.g. 0.2.0's `buzz` payload
  change) has bumped MINOR, not MAJOR — don't assume major-only-on-breaking
  until ≥ 1.0.0.
- `npm run prepublishOnly` (extraction check, tests, typecheck, build, smoke)
  must pass before a release-related change is considered complete.
