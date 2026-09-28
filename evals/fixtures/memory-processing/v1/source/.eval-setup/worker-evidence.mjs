export function workerReadEvidence(readResults, ids) {
  return Object.fromEntries(ids.map((id) => [id,
    readResults.includes(`"id":${JSON.stringify(id)}`)
      || readResults.includes(`"id": ${JSON.stringify(id)}`)
      || readResults.split('\n').some((line) => line.includes('[source session=')
        && line.includes(` entry=${JSON.stringify(id)} role=`)),
  ]));
}
