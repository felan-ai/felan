# Public package names

The credentials-free `pnpm check:packages` command queries npmjs for:

- `@felan-ai/agent-core`
- `@felan-ai/ext-context`
- `@felan-ai/ext-prewalk`
- `@felan-ai/ext-powerline`
- `@felan-ai/felan`

An HTTP 404 records an available name. An existing package passes only when its
repository metadata identifies `felan-ai/felan` and npm exposes its provenance
attestation, protecting later CI runs after the first prerelease.
