import { clipProcessText } from './data.js';
import type { BackgroundBashPage } from './job-store.js';

export const PROCESS_LIST_RESULT_BYTES = 64 * 1024;

export function formatProcessListResult(page: BackgroundBashPage) {
  const commandBytes = Math.min(512, Math.floor(8_000 / Math.max(1, page.jobs.length)));
  const jobs = page.jobs.map(job => {
    const command = clipProcessText(job.meta.command, commandBytes);
    return {
      meta: { id: job.meta.id, command, startedAt: job.meta.startedAt },
      status: {
        status: job.status.status,
        updatedAt: job.status.updatedAt,
        ...(job.status.pid === undefined ? {} : { pid: job.status.pid }),
        ...(job.status.exitCode === undefined ? {} : { exitCode: job.status.exitCode }),
        ...(job.status.signal === undefined ? {} : { signal: job.status.signal === null ? null : clipProcessText(job.status.signal, 34) }),
        ...(job.status.completedAt === undefined ? {} : { completedAt: job.status.completedAt }),
      },
      commandTruncated: command !== job.meta.command,
    };
  });
  const rows = jobs.map(job => `${job.meta.id}  ${job.status.status}  pid=${job.status.pid ?? '-'}  exit=${job.status.exitCode ?? job.status.signal ?? '-'}\n  ${job.meta.command.replace(/\s+/gu, ' ')}${job.commandTruncated ? '… [command clipped]' : ''}`).join('\n\n');
  const summary = clipProcessText(rows, 16 * 1024);
  const notices = [
    `Showing ${jobs.length} processes; scanned ${page.scanned} records.`,
    ...(page.hasMore ? [`More history available. Continue with cursor: ${page.nextCursor}`] : []),
    ...(jobs.some(job => job.commandTruncated) || summary !== rows ? ['Output clipped. Use read_background_bash with an ID for logs; full commands remain in stored job records.'] : []),
  ];
  const result = {
    content: [{ type: 'text' as const, text: `${summary || 'No matching background processes in this page.'}\n\n${notices.join('\n')}` }],
    details: {
      jobs,
      hasMore: page.hasMore,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      scanned: page.scanned,
      truncated: jobs.some(job => job.commandTruncated) || summary !== rows,
    },
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > PROCESS_LIST_RESULT_BYTES) {
    throw new Error('Process list exceeded its response budget.');
  }
  return result;
}
