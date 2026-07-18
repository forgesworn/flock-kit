# @forgesworn/flock

Framework-free protocol and policy primitives for location-aware safety and
trusted circles. This is the canonical package shared by the Flock and
Fledgling applications.

The package builds and evaluates protocol data. It does not own UI, storage,
relay selection, environment configuration, geolocation, permissions, or app
lifecycle.

## Install

Until a package release is published, consumers pin an immutable Git commit:

```json
{
  "dependencies": {
    "@forgesworn/flock": "git+https://github.com/forgesworn/flock-kit.git#<commit-sha>"
  }
}
```

## Public modules

- `geofence`, `noreport`, `policy`, `signals`
- `nightout`, `checkin`, `trail`
- `buzz`, `allclear`, `joined`, `disband`, `lost`, `findping`
- `fences`, `rendezvous`, `meeting`, `offgrid`, `spokenverify`, `radar`

Every module is available from the root barrel and from an explicit subpath,
for example:

```ts
import { decideEmission } from '@forgesworn/flock/policy'
import { buildBuzzSignal } from '@forgesworn/flock/buzz'
```

The root barrel also re-exports the `canary-kit` and `canary-kit/nostr`
surfaces retained by the original package contract.

## Compatibility

[`compatibility/v1`](compatibility/v1/) contains the frozen public vectors and
the manifest that maps all nineteen modules to focused tests. These fixtures
were extracted with the source history and must not be regenerated during a
consumer migration.

## Development

Requires Node 24 or newer.

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run smoke
```

`npm run prepublishOnly` runs the full provider gate. CI additionally checks
lint and the package tarball contents.

The protocol specification is in [`FLOCK.md`](FLOCK.md). The package is MIT
licensed.
