# Security policy

Report suspected vulnerabilities privately through GitHub Security Advisories
for `forgesworn/flock-kit`. Do not include real keys, locations, identities, or
relay traffic in a report.

This package composes established ForgeSworn primitives and contains policy and
wire-format code that can affect disclosure behaviour. Changes to encryption,
event kinds, tags, derivation paths, expiry, validation, or failure behaviour
must include compatibility vectors and consumer interoperability evidence.

No formal security audit is claimed. Applications remain responsible for
transport, key custody, permissions, persistence, platform behaviour, and user
consent.
