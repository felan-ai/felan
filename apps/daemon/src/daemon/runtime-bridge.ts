import { bindSubagentSession } from '@felan-ai/ext-subagents';
import { LocalSubagentHost, type CreateLocalSubagentHostOptions, type LocalSubagentView } from '../subagents/host.js';
import type { SessionRegistry } from './registry.js';

export async function createRegistrySubagentHost(
  registry: SessionRegistry,
  root: string,
  options: Omit<CreateLocalSubagentHostOptions, 'sessionId' | 'sessionFactory' | 'runChild' | 'lifecycle'>,
): Promise<LocalSubagentHost> {
  const prepared = await prepareRegistrySubagentHost(registry, root, options);
  prepared.bind(); return prepared.host;
}

export async function prepareRegistrySubagentHost(
  registry: SessionRegistry,
  root: string,
  options: Omit<CreateLocalSubagentHostOptions, 'sessionId' | 'sessionFactory' | 'runChild' | 'lifecycle'>,
): Promise<{ host: LocalSubagentHost; bind(): void }> {
  let active = false;
  let pending: readonly LocalSubagentView[] = [];
  const identities = new Map<string, string>([[root, root]]);
  const parent = (id: string) => {
    const actual = identities.get(id);
    if (!actual) throw new Error('Child parent is unavailable.');
    return actual;
  };
  const published = new Map<string, string>();
  const update = (records: readonly LocalSubagentView[]) => {
    if (!active) { pending = records; return; }
    for (const child of records) {
      if (child.sessionId) identities.set(child.agentId, child.sessionId);
      const session = identities.get(child.parentSessionId);
      if (!session) continue;
      const state = child.status === 'queued' || child.status === 'running' ? 'running' : child.status === 'completed' ? 'exited' : 'interrupted';
      const previous = registry.options.store.snapshot().resources.find(row => row.id === child.agentId);
      const actual = child.sessionId ? registry.options.store.snapshot().sessions.find(item => item.id === child.sessionId) : undefined;
      const key = JSON.stringify([state, actual?.id, actual?.run, actual?.state, child.description]);
      if (!previous || published.get(child.agentId) !== key) registry.recordResource({ id: child.agentId, session, root, kind: 'child', state, updatedAt: Date.now() }, actual
        ? { type: 'child.updated', child: { session: actual.id, parent: session, root, title: child.description, run: actual.run, state: actual.state } }
        : { type: 'presentation.updated', presentation: { id: child.agentId, kind: 'status', text: `Subagent ${child.status}` } });
      published.set(child.agentId, key);
    }
    registry.activatePolicy(root);
  };
  const host = await LocalSubagentHost.create({ ...options, sessionId: root, lifecycle: {
    assertCurrent: () => registry.options.owner.assertCurrent(),
    beforeAdmission: id => {
      if (!active) throw new Error('Root session is not active.');
      registry.assertNewWork();
      registry.assertDispatch(parent(id));
    },
    beforeDispatch: (_agent, id) => {
      if (!active) throw new Error('Root session is not active.');
      registry.assertNewWork();
      registry.activatePolicy(root);
      registry.assertDispatch(parent(id));
    },
    beforeCompletion: id => {
      registry.assertDispatch(parent(id));
    },
    recordsChanged: update,
  }, sessionFactory: async input => {
    const actualParent = parent(input.parentSessionId);
    registry.assertDispatch(actualParent);
    let binding;
    if (input.sessionFile) {
      const previous = registry.list().find(item => item.piPath === registry.options.owner.assertOwnsPath(input.sessionFile!));
      if (!previous) throw new Error('Retained child session is not registered.');
      binding = await registry.restore(previous.id, { systemPromptAppend: input.definition.prompt, subagentHost: input.subagents });
    } else {
      const model = input.request.model;
      const split = model?.indexOf('/') ?? -1;
      const selected = model && split > 0 ? options.modelRuntime.getModel(model.slice(0, split), model.slice(split + 1)) : undefined;
      binding = await registry.create({ cwd: input.cwd, sessionDir: registry.binding(root)!.resources.sessionDir, target: { kind: 'new' },
        rootSessionId: root, parentSessionId: actualParent, systemPromptAppend: input.definition.prompt, subagentHost: input.subagents, policy: registry.getPolicy(actualParent),
        ...(selected ? { model: selected } : {}), ...(input.request.thinking ? { thinkingLevel: input.request.thinking } : {}), source: 'headless' });
    }
    identities.set(input.sessionId, binding.sessionId);
    registry.bindSubagentView(binding.sessionId, input.subagents);
    registry.activatePolicy(root);
    registry.assertDispatch(actualParent);
    registry.assertDispatch(binding.sessionId);
    registry.projection(binding.sessionId).setOrigin({ kind: 'automation', source: 'subagent' });
    return { session: binding.runtime.session, dispose: async () => {
      registry.projection(binding.sessionId).refresh();
      registry.activatePolicy(root);
    } };
  } });
  return { host, bind() {
    if (active) return;
    const binding = registry.binding(root);
    if (!binding) throw new Error('Root session must be registered before subagent activation.');
    registry.bindSubagentHost(root, host);
    active = true; update(pending); pending = [];
    bindSubagentSession({ host, session: binding.runtime.session });
  } };
}

