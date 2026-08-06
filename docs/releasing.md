# Releasing

Public packages version and release independently. The private workspace root
has no release version. Bump only packages whose published contents or
dependency manifests changed; leave every unchanged package at its published
version.

Packages publish automatically from `main` with npm trusted publishing and
provenance. The release workflow has an OIDC identity token and contains no npm
credential. It packs workspace dependencies with pnpm and uses an OIDC-capable
npm 11 CLI to publish the resulting tarballs.

Before a release:

1. Run `pnpm check:licenses` to reject unknown, private, or non-permissive
   production dependencies and verify the Pi and TypeBox notices.
2. Update the version in each changed public package manifest. If a package
   must consume a new exact version of another workspace package, update and
   version that dependent package too.
3. Run `pnpm check:proposed-version`. It reports unpublished package versions
   as available and skips unchanged versions already present on npm. Confirm
   that every intended package appears as available.
4. Run `pnpm verify` on Node.js 22.20.0. The packed smoke installs with a clean
   npm configuration, checks each package's own version and exact workspace
   dependency versions, imports every public package through the installed
   application, constructs a local runtime, rejects unlisted packages, and runs
   the `felan` binary without credentials.
5. Configure each npm package's trusted publisher for this repository,
   `.github/workflows/release.yml`, and the `npm` environment. Allow the
   environment to deploy from `main` without a required approval when publication
   should be fully automatic.
6. Commit the changed public-package versions and merge them to `main`. The
   workflow selects only exact manifest versions that are not yet on npm and
   publishes them in dependency order: Agent Core, `ext-subagents`, the
   remaining extensions, then TUI. Stable versions publish to npm `latest`;
   prereleases publish to `next`. No Git tag is required. Reruns skip versions
   already published by a partially successful attempt.

For a new package, npm requires the package to exist before its trusted
publisher can be configured. Publish the verified tarball once with an
authenticated npm 11 CLI, then create the trust relationship before pushing the
release commit:

```sh
npm publish .artifacts/<package>-<version>.tgz --access public --provenance=false
npm trust github <package-name> \
  --repository felan-ai/felan \
  --file release.yml \
  --environment npm \
  --allow-publish
```

All subsequent versions publish from GitHub Actions with provenance.

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
publication, record the package versions, integrities, provenance, and source
commit before updating cloud dependencies.
