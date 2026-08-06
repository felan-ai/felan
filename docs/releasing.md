# Releasing

Public packages version and release independently. The private workspace root
has no release version. Bump packages whose published contents or dependency
manifests changed and leave unchanged packages at their published versions.

Extensions declare `@felan-ai/agent-core` as a compatible-minor peer dependency
and use `workspace:*` only as a development dependency. Agent Core patch
releases within that peer range do not require extension releases. Publish a
new extension version when its implementation, published manifest, or Agent
Core peer range changes.

Packages publish automatically from `main` with npm trusted publishing and
provenance. `.github/workflows/release.yml` receives an OIDC identity token,
packs workspace dependencies with pnpm, and publishes with npm 11.19.0. The
workflow stores no npm credential.

## Standard release

1. Update each changed public package's version. Update application versions
   when their published contents or exact workspace dependency versions change.
2. Add new public packages to `scripts/package-paths.mjs`, their consuming
   workspace manifests, the lockfile, packed-runtime coverage, license checks,
   and relevant notices.
3. Run the release gates on Node.js 22.20.0 and pnpm 9.15.5:

   ```sh
   pnpm check:licenses
   pnpm check:proposed-version
   pnpm verify
   ```

   `check:proposed-version` reports intended unpublished versions as available
   and skips unchanged versions already on npm. `verify` builds, type-checks,
   tests, packs, clean-installs, imports every public package, checks exact
   workspace dependency versions, constructs a runtime, and runs the `felan`
   binary without credentials.
4. Confirm that every package already present on npm trusts this repository's
   `release.yml` workflow and the `npm` GitHub environment.
5. Commit the release-facing changes and push or merge them to `main`.
6. Monitor the release workflow through verification and publication:

   ```sh
   gh run list --workflow release.yml --branch main
   gh run watch <run-id> --exit-status
   ```

The workflow selects exact manifest versions absent from npm and publishes in
the dependency order defined by `scripts/package-paths.mjs`. Stable versions use
the `latest` tag and prereleases use `next`. Reruns skip versions already
published by a partially successful attempt. Releases require no Git tag.

## Bootstrap a new npm package

npm requires a package to exist before it can receive a trusted-publisher
configuration. Establish a new package with a manually published `0.0.0`
bootstrap, then publish its intended initial version through GitHub Actions.
The committed package manifest always retains the intended release version,
such as `0.1.0`.

### 1. Build and verify the intended release

Complete the standard release preparation through `pnpm verify`. Confirm that
`.artifacts` contains the intended package tarball and inspect its manifest:

```sh
package_slug=ext-example
package_name="@felan-ai/$package_slug"
release_version=0.1.0
release_artifact=".artifacts/felan-ai-${package_slug}-${release_version}.tgz"

tar -xOf "$release_artifact" package/package.json
```

Use the package name after `@felan-ai/` as `package_slug`. Keep these variables
in the shell used for the remaining bootstrap steps.

### 2. Authenticate an npm owner

Use browser authentication so credentials and one-time codes stay outside the
terminal history:

```sh
npm whoami || true
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami
```

The authenticated account needs write access to the npm scope and write-level
2FA.

### 3. Derive and publish the bootstrap artifact

Create `0.0.0` from the already verified release tarball in a temporary
directory. This keeps the workspace manifest and Git history at the intended
release version.

```sh
bootstrap_dir="$(mktemp -d)"
bootstrap_artifact="$bootstrap_dir/felan-ai-${package_slug}-0.0.0.tgz"

tar -xzf "$release_artifact" -C "$bootstrap_dir"
(
  cd "$bootstrap_dir/package"
  npm pkg set version=0.0.0
  npm pack --ignore-scripts --pack-destination "$bootstrap_dir"
)

npm publish "$bootstrap_artifact" \
  --access public \
  --tag bootstrap \
  --provenance=false
```

Approve npm's browser-based write authorization when prompted. Verify the
package boundary even while public registry metadata is still propagating:

```sh
npm access get status "$package_name"
npm dist-tag ls "$package_name"
```

The bootstrap release intentionally has no provenance. npm may temporarily
point `latest` at `0.0.0`; the trusted release replaces it with the intended
version.

### 4. Configure GitHub trusted publishing

`npm trust` requires npm 11.15.0 or newer. Use the workflow's npm version
without changing the repository toolchain:

```sh
npm exec --yes --package=npm@11.19.0 -- npm trust github "$package_name" \
  --file release.yml \
  --repo felan-ai/felan \
  --env npm \
  --allow-publish \
  --yes

npm exec --yes --package=npm@11.19.0 -- \
  npm trust list "$package_name" --json
```

Approve npm's write authorization if prompted.

The resulting relationship must name:

- type `github`
- repository `felan-ai/felan`
- workflow file `release.yml`
- environment `npm`
- publish permission

### 5. Publish the intended version through CI

Confirm that the intended version remains available, then push or merge the
release commit to `main` and monitor the new workflow run:

```sh
pnpm check:proposed-version
gh run list --workflow release.yml --branch main
gh run watch <run-id> --exit-status
```

If the release commit triggered before bootstrap and stopped at `ENEEDAUTH`,
rerun it after confirming the trust relationship:

```sh
gh run rerun <failed-run-id>
gh run watch <failed-run-id> --exit-status
```

Investigate verification failures before rerunning. A failed publish step is
safe to rerun after correcting authentication because version selection skips
packages that a partial attempt already published.

### 6. Verify publication and clean up

Confirm versions, tags, exact workspace dependencies, and provenance:

```sh
npm view "$package_name@$release_version" \
  version dist-tags dist.attestations --json
felan_version=0.5.0
npm view "@felan-ai/felan@$felan_version" \
  version dist-tags dist.attestations dependencies --json
```

The intended stable versions must be `latest`, the application must reference
the intended package version, and CI-published versions must contain a
provenance attestation. Remove the temporary bootstrap directory. Log out when
the bootstrap procedure created the local npm session; preserve a maintainer
session that existed beforehand.

```sh
rm -r -- "$bootstrap_dir"
npm logout --registry=https://registry.npmjs.org/ # for a bootstrap-only login
```

## Packed audit

The release workflow records the packed dependency audit for stable versions:

```sh
pnpm audit:packed
```

The packed audit evaluates the exact dependencies installed from the generated
tarballs, including upstream shrinkwrap and extension runtime dependencies.
Record the audit output with the release evidence; `pnpm audit:packed` is
advisory and does not gate publication. After publication, record the package
versions, integrities, provenance, and source commit before updating cloud
dependencies.
