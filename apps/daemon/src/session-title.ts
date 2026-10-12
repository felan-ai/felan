import type { AgentRuntime, Logger, ModelRuntime } from '@felan-ai/agent-core';
import type { SessionTitleHost, SessionTitlePreparationRequest } from '@felan-ai/ext-session-title';
import type { DaemonControlStore } from './daemon/control-store.js';
import { ControlStoreError } from './daemon/control-state.js';

export function createLocalSessionTitleHost(
  modelRuntime: ModelRuntime,
  logger: Logger,
  eligible: (request: SessionTitlePreparationRequest) => boolean = request => request.mode === 'tui',
): SessionTitleHost {
  return {
    async prepare(request) {
      request.signal.throwIfAborted();
      if (request.parentSession !== undefined || !request.currentModel || !eligible(request)) return undefined;
      const models = await modelRuntime.getAvailable(request.currentModel.provider);
      request.signal.throwIfAborted();
      return { prompt: request.prompt, provider: request.currentModel.provider, models };
    },
    complete(request) { return modelRuntime.completeSimple(request.model, request.context, request.options); },
    reportError(failure) {
      logger.warn({ component: 'session-title', sessionId: failure.sessionId, stage: failure.stage }, 'Session title generation failed.');
    },
    reportSkip(skip) {
      if (skip.reason === 'title-already-set' || skip.reason === 'resumed-session') return;
      logger.debug({ component: 'session-title', sessionId: skip.sessionId, reason: skip.reason }, 'Session title generation skipped.');
    },
  };
}

export function createDaemonSessionTitleHost(modelRuntime: ModelRuntime, runtime: Pick<AgentRuntime, 'logger'>, store: Pick<DaemonControlStore, 'session'>): SessionTitleHost {
  return createLocalSessionTitleHost(modelRuntime, runtime.logger, request => {
    try {
      const session = store.session(request.sessionId);
      return session.id === session.root && session.parent === undefined && session.state === 'open'
        && session.run.state === 'running' && session.run.origin?.kind === 'tui';
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'not_found') return false;
      throw error;
    }
  });
}
