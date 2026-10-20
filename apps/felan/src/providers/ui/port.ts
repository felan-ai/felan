import type { Interaction, InteractionAnswer, InteractionAuthority } from '@felan-ai/session-protocol';

export type SessionUiOutcome =
  | { state: 'answered'; answer: InteractionAnswer }
  | { state: 'cancelled'; reason: 'user' | 'abort' | 'timeout' | 'unsupported' | 'drain' | 'restart' }
  | { state: 'deferred'; interactionId: string };

export interface SessionUiPort {
  request(
    request: Interaction['request'],
    options?: { readonly signal?: AbortSignal; readonly timeout?: number; readonly deferrable?: boolean; readonly transient?: boolean; readonly audience?: 'session' | 'owner' | 'host'; readonly authority?: InteractionAuthority },
  ): Promise<SessionUiOutcome>;
  canPresent(request: Interaction['request'], audience?: 'session' | 'owner' | 'host'): boolean;
  subscribeClients(listener: () => void): () => void;
}

