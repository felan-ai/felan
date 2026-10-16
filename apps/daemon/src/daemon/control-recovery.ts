import type { Interaction } from '@felan-ai/session-protocol';
import type { ControlState } from './control-state.js';

export interface RecoveryPlan {
  resumableContinuations: string[];
  reconcileDetached: string[];
  missingResources: string[];
  changedSessions: Set<string>;
}

export function recoverControlState(state: ControlState, now: number): RecoveryPlan {
  const plan: RecoveryPlan = { resumableContinuations: [], reconcileDetached: [], missingResources: [], changedSessions: new Set() };
  for (const request of state.requests) {
    if (request.phase === 'terminal') continue;
    const dispatched = request.phase === 'dispatch_intent';
    request.phase = 'terminal';
    request.response = { v: 1, re: request.id, outcome: dispatched ? 'indeterminate' : 'rejected', error: {
      code: dispatched ? 'indeterminate' : 'unavailable', retryable: false,
      message: dispatched ? 'Dispatch may have occurred before interruption; do not automatically retry.' : 'Request was not dispatched before interruption; a new explicit request is required.',
    } };
  }
  for (const session of state.sessions) {
    if (session.execution && !session.execution.completedAt) {
      session.execution.completedAt = new Date(now).toISOString();
      session.execution.outcome = 'cancelled';
      session.execution.error = { code: 'host_shutdown', message: 'Execution was interrupted by daemon restart.' };
      session.execution.completionPending = session.execution.request.notifyOnCompletion === true;
      delete session.execution.message;
      plan.changedSessions.add(session.id);
    }
    if (session.residency !== 'evicted' || !['idle', 'interrupted'].includes(session.run.state)) {
      session.residency = 'evicted';
      if (session.run.state !== 'idle') session.run.state = 'interrupted';
      plan.changedSessions.add(session.id);
    }
  }
  for (const resource of state.resources) {
    if (resource.state !== 'running' && resource.state !== 'reconciling') continue;
    resource.state = resource.kind === 'detached' ? 'reconciling' : 'missing';
    resource.updatedAt = now; plan.changedSessions.add(resource.session);
    (resource.kind === 'detached' ? plan.reconcileDetached : plan.missingResources).push(resource.id);
  }
  state.interactions = state.interactions.map((interaction): Interaction => {
    if (interaction.state !== 'waiting' && interaction.state !== 'deferred') return interaction;
    if (interaction.scope.kind === 'session') plan.changedSessions.add(interaction.scope.session);
    if (interaction.expiresAt !== undefined && interaction.expiresAt <= now) return { ...interaction, state: 'expired', resolvedAt: now, result: { cancelled: true, reason: 'timeout' } };
    if (interaction.deferrable) return { ...interaction, state: 'deferred', expiresAt: interaction.expiresAt ?? now + 30 * 60 * 1000 };
    return { ...interaction, state: 'cancelled', resolvedAt: now, result: { cancelled: true, reason: 'restart' } };
  });
  for (const continuation of state.continuations) {
    if (continuation.phase === 'dispatch_intent') {
      continuation.phase = 'indeterminate'; continuation.updatedAt = now; plan.changedSessions.add(continuation.session);
    } else if (continuation.phase === 'ready') {
      const interaction = state.interactions.find(item => item.id === continuation.interaction);
      const session = state.sessions.find(item => item.id === continuation.session);
      if (interaction?.state === 'answered' && interaction.deferrable && session?.state === 'open') plan.resumableContinuations.push(continuation.id);
      else { continuation.phase = 'cancelled'; continuation.updatedAt = now; plan.changedSessions.add(continuation.session); }
    }
  }
  return plan;
}
