import { validatePrompt } from './data.js';
import type { SessionSnapshot } from './events.js';
import { parseInteraction } from './interactions.js';
import { LIMITS, ProtocolValidationError, codePointLength, utf8Bytes } from './limits.js';

export function validateSnapshotInvariants(snapshot: SessionSnapshot): void {
  if (snapshot.history.revision !== snapshot.revision || snapshot.history.branch !== snapshot.branch) throw new ProtocolValidationError('invalid_request', 'Snapshot history cutover mismatch');
  const streams = [...snapshot.activeStreams, ...snapshot.completionOnlyStreams];
  if (streams.length > LIMITS.activeStreams || new Set(streams.map(stream => stream.id)).size !== streams.length) throw new ProtocolValidationError('invalid_request', 'Invalid snapshot stream identities');
  if (snapshot.activeStreams.reduce((sum, stream) => sum + utf8Bytes(stream.text), 0) > LIMITS.activeStreamsBytes) throw new ProtocolValidationError('invalid_request', 'Active stream aggregate limit exceeded');
  for (const stream of snapshot.activeStreams) if (codePointLength(stream.text) !== stream.offset) throw new ProtocolValidationError('invalid_request', 'Snapshot stream is not a complete prefix');
  for (const interaction of snapshot.interactions) parseInteraction(interaction);
  for (const item of snapshot.queue) validatePrompt(item.prompt);
  if (new Set(snapshot.queue.map(item => item.id)).size !== snapshot.queue.length) throw new ProtocolValidationError('invalid_request', 'Duplicate queue item');
}
