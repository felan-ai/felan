import type {
  AgentSession,
  AgentSessionRuntime,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createToolActivityDisplayDefinition } from './presentation.js';
import { ToolActivityState } from './state.js';

const sessionStates = new WeakMap<AgentSession, ToolActivityState>();
const sessionViews = new WeakMap<AgentSession, AgentSession>();
const displayDefinitions = new WeakMap<
  ToolActivityState,
  WeakMap<ToolDefinition<any, any, any>, ToolDefinition<any, any, any>>
>();

export function registerToolActivitySession(session: AgentSession, state: ToolActivityState): void {
  sessionStates.set(session, state);
}

export function createToolActivityRuntimeView<T extends AgentSessionRuntime>(runtime: T): T {
  const boundMethods = new Map<PropertyKey, { source: Function; bound: Function }>();
  return new Proxy(runtime, {
    get(target, property) {
      if (property === 'session') return sessionView(target.session);
      return boundValue(target, property, boundMethods);
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}

function sessionView(session: AgentSession): AgentSession {
  const state = sessionStates.get(session);
  if (!state) return session;
  const existing = sessionViews.get(session);
  if (existing) return existing;

  const boundMethods = new Map<PropertyKey, { source: Function; bound: Function }>();
  const getOriginalDefinition = session.getToolDefinition.bind(session);
  const view = new Proxy(session, {
    get(target, property) {
      if (property === 'getToolDefinition') {
        return (toolName: string) => presentationDefinition(
          state,
          toolName,
          getOriginalDefinition(toolName),
        );
      }
      return boundValue(target, property, boundMethods);
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
  sessionViews.set(session, view);
  return view;
}

function presentationDefinition(
  state: ToolActivityState,
  toolName: string,
  original: ToolDefinition<any, any, any> | undefined,
): ToolDefinition<any, any, any> | undefined {
  state.rememberDefinition(toolName, original);
  if (!original || state.mode === 'full' || state.isRendererPreserved(toolName)) return original;

  let cache = displayDefinitions.get(state);
  if (!cache) {
    cache = new WeakMap();
    displayDefinitions.set(state, cache);
  }
  const existing = cache.get(original);
  if (existing) return existing;
  const definition = createToolActivityDisplayDefinition(state, toolName, original);
  cache.set(original, definition);
  return definition;
}

function boundValue(
  target: object,
  property: PropertyKey,
  cache: Map<PropertyKey, { source: Function; bound: Function }>,
): unknown {
  const value = Reflect.get(target, property, target);
  if (typeof value !== 'function') return value;
  const cached = cache.get(property);
  if (cached && cached.source === value) return cached.bound;
  const bound = value.bind(target);
  cache.set(property, { source: value, bound });
  return bound;
}
