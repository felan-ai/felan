import type { AgentSession } from '@felan-ai/agent-core';
import type { SessionToolPolicy } from './session-runtime.js';
import type { SessionExecutionPolicy, ToolProvenance } from './session-lifecycle-contracts.js';

export function inheritExecutionPolicy(policy: SessionExecutionPolicy): SessionExecutionPolicy {
  if (!['host-default', 'acp-strict'].includes(policy.mode) || !Number.isSafeInteger(policy.generation)
    || policy.generation < 0 || typeof policy.pendingTightening !== 'boolean'
    || (policy.mode === 'acp-strict' && policy.pendingTightening)) throw new Error('Invalid session execution policy');
  return Object.freeze({ mode: policy.mode, pendingTightening: policy.pendingTightening, generation: policy.generation });
}

export class TrustedToolCatalog {
  readonly #tools = new Map<string, { readonly implementation: object; readonly provenance: ToolProvenance }>();

  private readonly approvalExemptTools: ReadonlySet<string>;

  constructor(private readonly definition: (name: string) => object | undefined, approvalExemptTools: readonly string[] = []) {
    this.approvalExemptTools = new Set(approvalExemptTools);
  }

  static fromSession(session: AgentSession, policy?: SessionToolPolicy): TrustedToolCatalog {
    const catalog = new TrustedToolCatalog(name => session.getToolDefinition(name), policy?.approvalExemptTools);
    const trustedInlinePaths = new Set(policy?.trustedInlinePaths);
    for (const tool of session.getAllTools()) {
      const definition = session.getToolDefinition(tool.name);
      if (!definition) continue;
      const sourceId = tool.sourceInfo?.path ?? 'unknown';
      const source = sourceId.startsWith('builtin:') || trustedInlinePaths.has(sourceId) ? 'builtin' : 'external';
      catalog.register(tool.name, definition, source, sourceId);
    }
    return catalog;
  }

  register(name: string, implementation: object, source: ToolProvenance['source'], sourceId: string): void {
    this.#tools.set(name, { implementation, provenance: Object.freeze({ name, source, sourceId }) });
  }

  get provenance(): readonly ToolProvenance[] {
    return Object.freeze([...this.#tools.values()].map(({ provenance }) => provenance));
  }

  requiresApproval(policy: SessionExecutionPolicy, name: string): boolean {
    if (policy.mode === 'host-default') return false;
    const registered = this.#tools.get(name);
    return !(this.approvalExemptTools.has(name) && registered?.provenance.source === 'builtin'
      && registered.implementation === this.definition(name));
  }
}
