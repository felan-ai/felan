export type {
  AgentRuntime,
  AgentRuntimeKind,
  ExecOptions,
  ExecResult,
} from './runtime.js';
export { HostAgentRuntime } from './host-agent-runtime.js';
export type { HostShellOptions } from './host-agent-runtime.js';
export {
  bindFelanExtension,
  loadFelanExtensions,
} from './extensions.js';
export type {
  ExtensionPackageImporter,
  FelanExtension,
  FelanExtensionAPI,
} from './extensions.js';
export { createAgentCoreResourceLoader } from './resource-loader.js';
export type { CreateAgentCoreResourceLoaderOptions } from './resource-loader.js';
export { createRuntimeCodingTools } from './tools.js';
export {
  createAgentCoreSession,
  createAgentCoreSessionRuntime,
  createAgentCoreSessionRuntimeFactory,
} from './session.js';
export type {
  AgentChildSessionRequest,
  AgentChildSessionResult,
  AgentCoreSessionRuntimeFactoryOptions,
  AgentCoreSessionRuntimeFactoryRequest,
  AgentCoreSessionRuntimeOptionsFactory,
  AgentSessionHost,
  CreateAgentCoreSessionOptions,
  StreamFunction,
} from './session.js';

export {
  AgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionRuntime,
} from '@earendil-works/pi-coding-agent';
export type {
  AgentSessionEvent,
  AgentSessionEventListener,
  AgentSessionRuntimeDiagnostic,
  AgentSessionServices,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  CreateAgentSessionRuntimeFactory,
  CreateAgentSessionRuntimeResult,
  Extension,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  InlineExtension,
  LoadExtensionsResult,
  ResourceLoader,
  SessionStartEvent,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
