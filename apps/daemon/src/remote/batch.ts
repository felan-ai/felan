import { LIMITS, PUBLICATION_LIMITS, type PublishedEvent, type PublishedSession, type PublishedTaskDetail } from '@felan-ai/session-protocol';

export function publicationBatches(session: PublishedSession, events: readonly PublishedEvent[]): PublishedEvent[][] {
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ p_session: session, p_events: [] }));
  if (envelopeBytes > PUBLICATION_LIMITS.batchBytes) throw new Error('Publication session exceeds the batch byte limit.');
  const batches: PublishedEvent[][] = []; let batch: PublishedEvent[] = []; let bytes = envelopeBytes;
  for (const event of events) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    if (event.session !== session.session) throw new Error('Publication event belongs to another session.');
    if (Buffer.byteLength(JSON.stringify(event.change)) > PUBLICATION_LIMITS.changeBytes || envelopeBytes + eventBytes > PUBLICATION_LIMITS.batchBytes) throw new Error('Publication event exceeds the byte limit.');
    if (batch.length >= PUBLICATION_LIMITS.eventsPerBatch || bytes + eventBytes + (batch.length ? 1 : 0) > PUBLICATION_LIMITS.batchBytes) {
      batches.push(batch); batch = []; bytes = envelopeBytes;
    }
    bytes += eventBytes + (batch.length ? 1 : 0); batch.push(event);
  }
  if (batch.length || !batches.length) batches.push(batch);
  return batches;
}

export function taskDetailBatches(session: string, tasks: readonly PublishedTaskDetail[]): PublishedTaskDetail[][] {
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ p_session: session, p_tasks: [] }));
  const batches: PublishedTaskDetail[][] = []; let batch: PublishedTaskDetail[] = []; let bytes = envelopeBytes;
  for (const task of tasks) {
    const taskBytes = Buffer.byteLength(JSON.stringify(task));
    if (envelopeBytes + taskBytes > PUBLICATION_LIMITS.batchBytes) throw new Error('Published task exceeds the batch byte limit.');
    if (batch.length >= LIMITS.pageEntries || bytes + taskBytes + (batch.length ? 1 : 0) > PUBLICATION_LIMITS.batchBytes) {
      batches.push(batch); batch = []; bytes = envelopeBytes;
    }
    bytes += taskBytes + (batch.length ? 1 : 0); batch.push(task);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
