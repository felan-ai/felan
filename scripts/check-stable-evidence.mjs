import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const stableVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(stableVersion)) {
  throw new Error(`Stable evidence requires a stable version; received ${stableVersion}`);
}
const evidencePath = resolve(root, 'release-evidence', `${stableVersion}.json`);
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
const packageNames = await Promise.all(packagePaths.map(async (packagePath) => (
  JSON.parse(await readFile(resolve(root, packagePath, 'package.json'), 'utf8')).name
)));

if (evidence.stableVersion !== stableVersion) throw new Error('Evidence stableVersion does not match');
if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(evidence.prereleaseVersion ?? '')) {
  throw new Error('Evidence prereleaseVersion must be exact');
}
if (evidence.prereleaseVersion.split('-')[0] !== stableVersion) {
  throw new Error('Evidence prerelease and stable versions must share a base version');
}
if (evidence.publicRepository !== 'https://github.com/felan-ai/felan') {
  throw new Error('Evidence public repository is invalid');
}
if (!/^[0-9a-f]{40}$/.test(evidence.publicCommit ?? '')) throw new Error('Evidence publicCommit is invalid');
if (evidence.publicRef !== `refs/tags/v${evidence.prereleaseVersion}`) {
  throw new Error('Evidence publicRef does not match prereleaseVersion');
}
if (evidence.workflow !== '.github/workflows/release.yml') throw new Error('Evidence workflow is invalid');
if (!/^\d+$/.test(String(evidence.privateCandidate?.trustedRunId ?? ''))) {
  throw new Error('Evidence trusted candidate run is invalid');
}
if (!/^[0-9a-f]{40}$/.test(evidence.privateCandidate?.privateCommit ?? '')) {
  throw new Error('Evidence private candidate commit is invalid');
}
if (!/^sha256:[0-9a-f]{64}$/.test(evidence.privateCandidate?.recordDigest ?? '')) {
  throw new Error('Evidence candidate record digest is invalid');
}

const evidenceNames = Object.keys(evidence.packages ?? {}).sort();
if (evidenceNames.join('\n') !== [...packageNames].sort().join('\n')) {
  throw new Error('Evidence package set does not match the fixed public package set');
}

for (const packageName of packageNames) {
  const expected = evidence.packages[packageName];
  if (expected.version !== evidence.prereleaseVersion || !/^sha512-/.test(expected.integrity ?? '')) {
    throw new Error(`${packageName} evidence version or integrity is invalid`);
  }
  const metadataResponse = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${evidence.prereleaseVersion}`,
  );
  if (!metadataResponse.ok) throw new Error(`Unable to resolve ${packageName} from npmjs`);
  const metadata = await metadataResponse.json();
  if (metadata.dist?.integrity !== expected.integrity || !metadata.dist?.attestations?.url) {
    throw new Error(`${packageName} npm integrity or provenance differs from evidence`);
  }
  const attestationResponse = await fetch(metadata.dist.attestations.url);
  if (!attestationResponse.ok) throw new Error(`Unable to fetch ${packageName} provenance`);
  const attestations = await attestationResponse.json();
  const provenance = attestations.attestations?.find(
    (entry) => entry.predicateType === 'https://slsa.dev/provenance/v1',
  );
  const payload = provenance?.bundle?.dsseEnvelope?.payload;
  if (!payload) throw new Error(`${packageName} has no SLSA provenance payload`);
  const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const dependency = statement.predicate?.buildDefinition?.resolvedDependencies?.find(
    (entry) => entry.uri === `git+https://github.com/felan-ai/felan@${evidence.publicRef}`,
  );
  if (
    workflow?.repository !== evidence.publicRepository
    || workflow?.path !== evidence.workflow
    || workflow?.ref !== evidence.publicRef
    || dependency?.digest?.gitCommit !== evidence.publicCommit
  ) {
    throw new Error(`${packageName} provenance differs from stable candidate evidence`);
  }
}

console.log(`Stable evidence validates ${packageNames.length} packages from ${evidence.publicRef}`);
