# Flock compatibility vectors v1

This directory is the public, versioned compatibility contract for
`@forgesworn/flock`. Extraction into `flock-kit` must preserve these fixtures
without regenerating them. Consumers can run the tests against a candidate
package before changing an application dependency.

The JSON files cover the cross-language JavaScript/Kotlin boundary:

- `vectors.json` freezes key derivation, group IDs, geohashes, encrypted beacon
  decryptability, NIP-44 and NIP-59 wrapping.
- `radar-vectors.json` freezes the pure radar guidance rules.
- `protocol-vectors.test.ts` verifies deterministic derivations and decrypts
  the committed beacon and NIP-44 samples without any application adapters.

`manifest.json` maps all nineteen public subpath exports to focused tests for
their wire-visible or policy-visible behaviour. `src/compatibility-manifest.test.ts`
fails if a public export lacks a source module, focused test, or manifest row.

Run:

```sh
npm test
npm run typecheck
npm run build
```

Regenerate committed JSON only for an intentional protocol change:

```sh
npm run gen:vectors
```
