import { randomUUID } from 'node:crypto';
import type { BackgroundBashPresentationHost } from '@felan-ai/ext-background-bash';
import { PROCESS_VIEW_PRESENTER, PROCESS_VIEW_PAGE_SIZE, clipProcessText, processViewJob,
  parseProcessViewRequest, parseProcessViewAction, splitProcessLog, type ProcessViewRequest } from '@felan-ai/ext-background-bash/view';
import { JsonValueSchema, parseSchema, type Interaction } from '@felan-ai/session-protocol';
import type { BrokerOutcome } from './broker.js';

export function createBrokerProcessHost(options: {
  signal: AbortSignal;
  request(value: Interaction['request'], dialog: { signal: AbortSignal }): Promise<BrokerOutcome>;
  unsupported(surface: string): never;
}): BackgroundBashPresentationHost {
  let active = false;
  return {
    status(ui, count) { if (options.signal.aborted) return; ui.setStatus('background-bash', count === undefined || count === 0 ? undefined
      : count === 'unavailable' ? 'Processes unavailable' : `${count} running ${count === 1 ? 'process' : 'processes'}`); },
    async show(ui, source, callerSignal) {
      if (active) { ui.notify('A process view is already open for this session.', 'warning'); return; }
      active = true;
      const signal = AbortSignal.any([options.signal, callerSignal]);
      const viewId = randomUUID(); let sequence = 0; let offset = 0;
      let selectedId: string | undefined; let detail = false;
      let chunks = ['']; let chunk = 0; let notice: string | undefined;
      const list = async () => { signal.throwIfAborted(); const result = await source.list('all'); signal.throwIfAborted(); return result; };
      const tail = async () => {
        if (!detail || !selectedId) return;
        chunks = ['']; chunk = 0;
        signal.throwIfAborted(); const result = await source.tail(selectedId, 2000); signal.throwIfAborted();
        chunks = splitProcessLog(result); chunk = chunks.length - 1;
      };
      try {
        let jobs: Awaited<ReturnType<typeof list>> = [];
        const refresh = async () => {
          jobs = await list();
          const index = jobs.findIndex(job => job.meta.id === selectedId);
          if (index >= 0) offset = Math.floor(index / PROCESS_VIEW_PAGE_SIZE) * PROCESS_VIEW_PAGE_SIZE;
          else if (selectedId) { selectedId = undefined; detail = false; notice = 'The selected process no longer exists.'; }
        };
        try { await refresh(); }
        catch (error) { signal.throwIfAborted(); notice = clipProcessText(error instanceof Error ? error.message : String(error), 512); }
        while (!signal.aborted) {
          offset = Math.min(offset, Math.max(0, Math.floor((jobs.length - 1) / PROCESS_VIEW_PAGE_SIZE) * PROCESS_VIEW_PAGE_SIZE));
          const page = jobs.slice(offset, offset + PROCESS_VIEW_PAGE_SIZE);
          if (!page.some(job => job.meta.id === selectedId)) { selectedId = page[0]?.meta.id; detail = false; }
          const request: ProcessViewRequest = parseProcessViewRequest({ viewId, sequence: ++sequence, offset, total: jobs.length,
            running: jobs.filter(job => job.status.status === 'running').length, jobs: page.map(processViewJob),
            ...(selectedId ? { selectedId } : {}), ...(notice ? { notice } : {}),
            ...(detail ? { detail: { id: selectedId!, index: chunk, chunks: chunks.length, text: chunks[chunk]! } } : {}) });
          const result = await options.request({ kind: 'custom', presenter: PROCESS_VIEW_PRESENTER, data: parseSchema(JsonValueSchema, request) }, { signal });
          signal.throwIfAborted();
          if (result.state !== 'answered') {
            if (result.state === 'cancelled' && result.reason === 'unsupported') options.unsupported('process view');
            return;
          }
          if (result.answer.kind !== 'custom') throw new Error('Invalid process view answer.');
          const action = parseProcessViewAction(result.answer.data, request);
          if (action.action === 'close') return;
          notice = undefined;
          try {
            switch (action.action) {
              case 'list': detail = false; break;
              case 'page':
                offset = action.offset; detail = false;
                selectedId = jobs[Math.min(jobs.length - 1, offset + (action.select === 'last' ? PROCESS_VIEW_PAGE_SIZE - 1 : 0))]?.meta.id;
                break;
              case 'detail': selectedId = action.id; detail = true; await tail(); break;
              case 'output': chunk = action.index; break;
              case 'refresh': await refresh(); await tail(); break;
              case 'signal': {
                jobs = await list();
                if (!jobs.some(job => job.meta.id === action.id)) { detail = false; notice = 'The selected process no longer exists.'; break; }
                signal.throwIfAborted();
                selectedId = action.id;
                await source.stop(action.id, action.signal);
                signal.throwIfAborted();
                await refresh();
                notice = `${action.signal === 'SIGTERM' ? 'Stop' : 'Kill'} requested for ${action.id}.`;
                await tail();
                break;
              }
            }
          } catch (error) {
            signal.throwIfAborted();
            notice = clipProcessText(error instanceof Error ? error.message : String(error), 512);
          }
        }
      } finally { active = false; }
    },
  };
}
