# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-18

Initial release of `@forgesworn/flock` as a standalone, framework-free
package — protocol and policy primitives for location-aware safety and
trusted circles, extracted for shared use by the Flock and Fledgling
applications.

### Added

- Core protocol modules: `geofence`, `noreport`, `policy`, `signals`.
- Circle and safety modules: `nightout` (ephemeral groups, presence,
  separation), `checkin` (dead-man's-switch, self-reminders, escalation),
  `trail` (pre-SOS breadcrumbs), `buzz` (circle ping with a chosen reason,
  location roll-call), `allclear`, `joined`, `disband` (circle tombstone),
  and `lost`/`findping` (lost-phone flagging, pre-authorised remote ping,
  "make it ring" alarm).
- Location-sharing modules: `fences` (safe-places sync), `rendezvous` and
  `meeting` (ETA, arrival detection, fair meeting-point engine, venue lookup
  via OSM Nominatim, per-person exact precision), `offgrid` mode, and
  accuracy-matched location sharing (low-power coarse shares, adaptive
  family breach, fresh-fix SOS).
- `spokenverify` — spoken pick-up verification with an exposed risk budget.
- `radar` — locked-phone guide mode with native beeps/haptics and zoom-in
  guidance to a 2 m endgame.
- Transport: gift-wrap-everything wire model (all signals via a rotating
  group inbox, uniform NIP-40 expiry, cadence jitter and low-rate cover
  traffic), deterministic circle seeds via `nsec-tree`, and geofence maths
  delegated to `geohash-kit`.
- Signing: FlockSigner-based NIP-59 gift-wrapping, Sign in with Signet, and
  sign-in with any NIP-46 signer (Amber, nsec.app, bunker).
- Native app surfaces (Capacitor/Android): background location watch,
  hosted APK download, scanned-invite deep links, system notifications
  while hidden, decoy view, app lock via keystore-kit, and reproducible
  APK builds with off-host release attestation.
- Release engineering: GitHub Actions CI gates, an exhaustive
  `decideEmission` truth-table test, a two-person Playwright end-to-end
  suite, public `compatibility/v1` vectors for cross-repository consumers,
  and a `check:extraction` guard for the standalone package boundary.

### Fixed

- No-report zones now fail safe under GPS noise (possibly-inside is
  treated as inside).
- QR/link joiners are no longer invisible until their first signal.
- A map-rendering issue where `.maplibregl-map` position beat
  `.map-canvas` in the app shell.
- Release verification is now enforced as complete before publish.

[0.1.0]: https://github.com/forgesworn/flock-kit/releases/tag/v0.1.0
