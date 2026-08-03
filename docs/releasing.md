# Releasing

Public packages use one version and publish from the release workflow with npm
trusted publishing and provenance. The workflow has an OIDC identity token and
contains no npm credential. It packs workspace dependencies with pnpm and uses
an OIDC-capable npm 11 CLI to publish the resulting tarballs.

The current combined S7-S10 prerelease version is `0.1.0-alpha.2`. The root and
all five public manifests form one fixed version group. Agent Core diagnostics
report the same package-derived version.

Before a prerelease:

1. Run `pnpm check:packages` to verify each public package name on npmjs.
2. Run `pnpm check:release` to validate the fixed version group, prerelease tag
   policy, OIDC provenance, and topological pack/publish order.
3. Run `pnpm check:proposed-version` to confirm the exact proposed version is
   unused for every public package. This preparation-only check stays outside
   `pnpm verify`, so ordinary CI remains valid after publication.
4. Run `pnpm verify` on Node.js 22.20.0. The packed smoke installs with a clean
   npm configuration, checks exact workspace dependency versions, imports every
   public package through the installed application, constructs a local runtime,
   rejects unlisted packages, and runs the `felan` binary without credentials.
5. Configure each npm package's trusted publisher for this repository and workflow.
6. Create the matching prerelease `v<version>` tag through the normal reviewed
   release process. The workflow publishes in dependency order: Agent Core,
   extensions, then TUI, all with the npm `next` dist-tag.

## Stable readiness

Stable publication follows successful prerelease integration with public host
and private cloud runtime adapters. Run the validation-only **Stable release
readiness** workflow with a packed tarball or published package spec for the
Story 11 `@felan-ai/cli` release. The workflow performs:

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm audit:packed
pnpm test:co-install -- --cli <tarball-or-@felan-ai/cli@version>
```

`test:co-install` uses the packed TUI set in `.artifacts` by default. It also
accepts `--tui <tarball-or-package-spec>` and the `FELAN_CLI_PACKAGE` and
`FELAN_TUI_PACKAGE` environment variables. It uses no sibling checkout and
requires the platform CLI to expose only `felan-cli` while the local TUI exposes
only `felan`.

The clean audit currently reports the vulnerable `brace-expansion@5.0.7`
locked by the published Pi 0.82.1 shrinkwrap. Pi has no safe compatible npm
release yet. Stable publication remains blocked by `bugzy-3bfl.16`; the exact
Pi 0.82.1 pin remains unchanged until a reviewed upstream release is available.

The stable gate also requires the renamed platform CLI publication. The current
public `@felan-ai/cli@0.1.0` still exposes `felan`, so it is not a valid input.
