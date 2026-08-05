# Releasing

Public packages use one version and publish from the release workflow with npm
trusted publishing and provenance. The workflow has an OIDC identity token and
contains no npm credential. It packs workspace dependencies with pnpm and uses
an OIDC-capable npm 11 CLI to publish the resulting tarballs.

The current release version is `0.2.0`. The root and all six public manifests
form one fixed version group. Agent Core diagnostics report the same
package-derived version.

Before a release:

1. Run `pnpm check:licenses` to reject unknown, private, or non-permissive
   production dependencies and verify the Pi and TypeBox notices.
2. Run `pnpm check:proposed-version` to confirm the exact proposed version is
   unused for every public package. This preparation-only check stays outside
   `pnpm verify`, so ordinary CI remains valid after publication.
3. Run `pnpm verify` on Node.js 22.20.0. The packed smoke installs with a clean
   npm configuration, checks exact workspace dependency versions, imports every
   public package through the installed application, constructs a local runtime,
   rejects unlisted packages, and runs the `felan` binary without credentials.
4. Configure each npm package's trusted publisher for this repository and workflow.
5. Create the matching `v<version>` tag through the normal reviewed release
   process. The workflow publishes in dependency order: Agent Core,
   `ext-subagents`, the remaining extensions, then TUI. Stable versions publish
   to npm `latest`; prereleases publish to `next`.

## Packed audit

The release workflow records the packed dependency audit for stable versions:

```sh
pnpm audit:packed
```

The clean audit currently reports vulnerable `brace-expansion@5.0.7` and
`undici@8.5.0` versions locked by the published Pi 0.83.0 shrinkwrap. The
release accepts this upstream dependency risk. Record the audit output with the
release evidence; `pnpm audit:packed` is advisory and does not gate publication.
`bugzy-3bfl.16` tracks adoption of an upstream fix independently. After
publication, record the package versions, integrities, provenance, source tag,
and source commit before updating cloud dependencies.
