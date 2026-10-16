# @forgesworn/flock

Framework-free protocol and policy primitives for location-aware safety and
trusted circles. This is the canonical package shared by the Flock application
and other ForgeSworn clients.

The package builds and evaluates protocol data. It does not own UI, storage,
relay selection, environment configuration, geolocation, permissions, or app
lifecycle.

It targets Nostr, layered on `canary-kit`. Builders return unsigned inner
events (kind 20078 signals, kind 30078 group state). Most of them derive keys
from the group seed and encrypt the payload themselves. Encoding geohashes,
gift-wrapping per recipient (NIP-59), signing and publishing are the
consuming app's job.

## Install

Until a package release is published, consumers pin an immutable Git commit.
Find one and install it:

```sh
git ls-remote https://github.com/forgesworn/flock-kit main
npm install github:forgesworn/flock-kit#<sha>
```

`<sha>` is the 40-character commit from the first command. `package.json` is at
0.2.0 but only `v0.1.0` is tagged, so pin a commit, not a tag. A git install
runs the package's `prepare` script, which compiles `dist/` with `tsc`, so no
prebuilt output is needed. The equivalent `package.json` entry is:

```json
{
  "dependencies": {
    "@forgesworn/flock": "git+https://github.com/forgesworn/flock-kit.git#<commit-sha>"
  }
}
```

## Quick start

The root import also re-exports `canary-kit`, which is where `createGroup`
comes from. `geohash-kit` and `nostr-tools` are not re-exported, so add them to
your own dependencies (`npm install geohash-kit nostr-tools`).

```ts
import {
  createGroup,
  decideEmission,
  signalTypeForReason,
  buildLocationSignal,
} from '@forgesworn/flock'
import { encode } from 'geohash-kit'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { wrapEvent } from 'nostr-tools/nip59'

const mySecretKey = generateSecretKey()
const friendPubkey = getPublicKey(generateSecretKey())

// 1. A circle. `group.seed` is the 64-char hex `seedHex` every builder takes.
//    Keep it secret: it derives the circle's encryption keys.
const group = createGroup({ name: 'Night out', members: [getPublicKey(mySecretKey), friendPubkey] })
const seedHex = group.seed
const groupId = 'night-out-1'

// 2. Decide what, if anything, to disclose (pure policy, no I/O).
const position = { lat: 51.5007, lon: -0.1246 }
const plan = decideEmission({ mode: 'nightout', position })
const signalType = signalTypeForReason(plan.reason)

// A `help` reason is sent with buildHelpSignal instead.
if (plan.action !== 'withhold' && signalType !== null && signalType !== 'help') {
  // 3. Encode the geohash yourself, then build the unsigned, encrypted inner event.
  const geohash = encode(position.lat, position.lon, plan.precision)
  const inner = await buildLocationSignal({
    groupId, seedHex, signalType, geohash, precision: plan.precision,
  })

  // 4. Gift-wrap for each recipient. NIP-59 keeps the inner event an unsigned
  //    rumour: the seal carries your signature, so do not call finalizeEvent first.
  const wrap = wrapEvent(inner, mySecretKey, friendPubkey)

  // 5. Publish `wrap` (kind 1059) to your relays. Never publish `inner`.
}
```

Gift-wrapping is mandatory: a signal published without it breaks the privacy
model (see [`FLOCK.md`](FLOCK.md) §3.3 and §6). `wrapEvent` adds only a `p` tag,
not the NIP-40 `expiration` that `FLOCK.md` §6 asks every wrap to carry. An app
that wants bounded relay retention needs its own wrap step built from
`createRumor`, `createSeal` and `createWrap`.

## Public modules

- `geofence`, `noreport`, `policy`, `signals`
- `nightout`, `checkin`, `trail`
- `buzz`, `allclear`, `joined`, `disband`, `lost`, `findping`
- `fences`, `rendezvous`, `meeting`, `offgrid`, `spokenverify`
- `radar`, `radarSession`

That is twenty subpath modules. A twenty-first, `coordination` (the fixed
vocabulary behind `buzz`), is exported from the root barrel only and has no
subpath.

Each of the twenty is available from the root barrel and from an explicit
subpath, for example:

```ts
import { decideEmission } from '@forgesworn/flock/policy'
import { buildBuzzSignal } from '@forgesworn/flock/buzz'
```

The root barrel also re-exports the `canary-kit` and `canary-kit/nostr`
surfaces retained by the original package contract.

## Compatibility

[`compatibility/v1`](compatibility/v1/) contains the frozen public vectors and
the manifest that maps all twenty subpath modules to focused tests. These
fixtures were extracted with the source history and must not be regenerated
during a consumer migration.

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
