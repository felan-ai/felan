# Releasing

Public packages use one version and publish from the release workflow with npm
trusted publishing and provenance. The workflow has an OIDC identity token and
contains no npm credential. It packs workspace dependencies with pnpm and uses
an OIDC-capable npm 11 CLI to publish the resulting tarballs.

Before a prerelease:

1. Run `pnpm check:packages` to verify each public package name on npmjs.
2. Run `pnpm verify` on Node.js 22.20.0.
3. Confirm every package version is the same prerelease version.
4. Configure each npm package's trusted publisher for this repository and workflow.
5. Create the matching `v<version>` tag through the normal reviewed release process.

Stable publication follows successful prerelease integration with public host and
private cloud runtime adapters.
