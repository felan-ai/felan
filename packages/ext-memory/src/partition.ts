import type { MemoryTriageDecision } from './triage.js';

export interface MemoryTranscriptPartition {
  readonly inspect: string;
  readonly noise: string;
}

export function partitionMemoryTranscript(
  transcript: string,
  transcriptPath: string,
  decisions: readonly MemoryTriageDecision[],
): MemoryTranscriptPartition {
  const byEntry = new Map<string, MemoryTriageDecision>();
  for (const decision of decisions) {
    const reference = decision.reference;
    if (!('transcriptPath' in reference) || reference.transcriptPath !== transcriptPath) continue;
    if (byEntry.has(reference.entryId)) throw new Error('Duplicate memory triage entry reference');
    byEntry.set(reference.entryId, decision);
  }
  const inspect: string[] = [];
  const noise: string[] = [];
  const seen = new Set<string>();
  for (const line of transcript.split('\n')) {
    if (!line) continue;
    const entry: unknown = JSON.parse(line);
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || typeof entry.id !== 'string'
      || seen.has(entry.id)) throw new Error('Invalid or duplicate memory evidence entry');
    seen.add(entry.id);
    (byEntry.get(entry.id)?.decision === 'noise' ? noise : inspect).push(line);
  }
  if ([...byEntry.keys()].some((id) => !seen.has(id))) throw new Error('Memory triage reference missing from transcript');
  return {
    inspect: inspect.length ? `${inspect.join('\n')}\n` : '',
    noise: noise.length ? `${noise.join('\n')}\n` : '',
  };
}
