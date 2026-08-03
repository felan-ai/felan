const packageNames = [
  '@felan-ai/agent-core',
  '@felan-ai/ext-context',
  '@felan-ai/ext-prewalk',
  '@felan-ai/ext-powerline',
  '@felan-ai/felan',
];

let failed = false;

for (const packageName of packageNames) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
  if (response.status === 404) {
    console.log(`${packageName}: available`);
    continue;
  }

  if (!response.ok) {
    console.error(`${packageName}: registry returned HTTP ${response.status}`);
    failed = true;
    continue;
  }

  const metadata = await response.json();
  const repository = metadata.repository;
  const repositoryValue = typeof repository === 'string' ? repository : repository?.url;
  if (typeof repositoryValue !== 'string' || !repositoryValue.includes('felan-ai/felan')) {
    console.error(`${packageName}: owned by an unexpected repository`);
    failed = true;
    continue;
  }

  const publishedVersion = metadata['dist-tags']?.next ?? metadata['dist-tags']?.latest;
  const attestations = metadata.versions?.[publishedVersion]?.dist?.attestations;
  if (!publishedVersion || typeof attestations?.url !== 'string') {
    console.error(`${packageName}: published package has no npm provenance attestation`);
    failed = true;
    continue;
  }

  console.log(`${packageName}@${publishedVersion}: published from felan-ai/felan with provenance`);
}

if (failed) {
  process.exit(1);
}
