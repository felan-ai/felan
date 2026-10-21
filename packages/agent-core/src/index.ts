export {
  LOG_LEVELS,
  createLogger,
  createSilentLogger,
  isLogLevel,
  isLoggerLevel,
} from './logger.js';
export type {
  CreateLoggerOptions,
  LogLevel,
  LogRecord,
  Logger,
  LoggerDestination,
  LoggerFields,
  LoggerLevel,
} from './logger.js';
export type {
  AgentRuntime,
  AgentRuntimeFileReadOptions,
  AgentRuntimeFileWriteOptions,
  AgentRuntimeExecOptions,
  AgentRuntimeExecResult,
  AgentRuntimeListFilesOptions,
  AgentRuntimeKind,
  AgentRuntimeProcess,
  AgentRuntimeProcesses,
  AgentRuntimeProcessReadOptions,
  AgentRuntimeProcessSnapshot,
  AgentRuntimePrivateRuntime,
  AgentRuntimeShellFlavor,
  AgentRuntimeTerminationSignal,
  AgentRuntimeShellOptions,
  AgentRuntimeShellProcessOptions,
  AgentRuntimeStdioProcess,
  AgentRuntimeStdioProcessOptions,
  AgentRuntimeStorage,
  AgentRuntimeStorageScope,
  AgentRuntimeTerminals,
  AgentRuntimeTerminalOptions,
  ExecOptions,
  ExecResult,
} from './runtime.js';
export type {
  SavingsCategory,
  SavingsMeasurement,
  SavingsModelReference,
  SavingsOutcome,
  SavingsReporter,
  SavingsReporterProvider,
  SavingsTokenUsage,
  SavingsSummary,
  UsageService,
} from './savings.js';
export { USAGE_SERVICE } from './savings.js';
export { FELAN_PLATFORM_SERVICE } from './platform.js';
export type { FelanApiMethod, FelanApiTarget, FelanApiQueryValue, FelanApiRequest, FelanApiResultDetails, FelanPlatformService } from './platform.js';
export { AGENT_CORE_VERSION } from './version.js';
export type { SessionSelectionAutomation } from './model-selection.js';
export * from './classifier/index.js';
export * from './dynamic-thinking/index.js';
export {
  MODEL_TIERS,
  formatModelReference,
  getModelFamily,
  getModelStrength,
  isModelTier,
  parseModelReference,
  selectModelForTier,
} from './model-tiers.js';
export type {
  ModelReference,
  ModelTier,
  ModelTierClassifier,
  ModelTierSelection,
} from './model-tiers.js';
export { FELAN_THINKING_LEVELS, isFelanThinkingLevel } from './thinking.js';
export type { FelanThinkingLevel } from './thinking.js';
export { createLocalRuntimeStorage, HostAgentRuntime } from './host-agent-runtime.js';
export type { RuntimeFiles, RuntimeFileInfo, RuntimeFileSnapshot } from './runtime-files.js';
export type { HostAgentRuntimeOptions, HostShellOptions } from './host-agent-runtime.js';
export {
  bindFelanExtension,
  loadFelanExtensions,
} from './extensions.js';
export { createFelanServiceRegistry, defineServiceContract, createExtensionServiceAccess, HOST_RUNTIME_SERVICE } from './services.js';
export { createUnavailableExtensionUi, ExtensionUiUnavailableError } from './extension-ui.js';
export type {
  ExtensionUi,
  ExtensionUiBindingFactory,
  UiActionContext,
  UiCancelReason,
  UiElementHandle,
  UiInteractiveElement,
  UiPresentOptions,
  UiRequestOptions,
  UiRequestResult,
} from './extension-ui.js';
export type {
  UiActionRequest,
  UiAction,
  UiDocument,
  UiField,
  UiFormAnswer,
  UiForm,
  UiInput,
  UiPresentation,
  UiProgress,
  UiStatus,
  UiStatusValue,
  UiValues,
  UiView,
} from '@felan-ai/session-protocol';
export type { ExtensionServiceAccess, ExtensionServiceRequirements, FelanServiceRegistry, HostRuntimeService, ServiceContract } from './services.js';
export { MODELS_SERVICE } from './services/models.js';
export type { ImageModelInfo, ModelSubscriptionUsageResult, ModelsCallOptions, ModelsRequestOptions, ModelsService, TextModelInfo } from './services/models.js';
export { SECRETS_SERVICE, SECRETS_LIMITS, SecretServiceError } from './services/secrets.js';
export type { SecretAddress, SecretRecord, SecretsRequestOptions, SecretsService, SecretServiceErrorCode } from './services/secrets.js';
export { SESSIONS_SERVICE, SESSIONS_HISTORY_SERVICE, SESSION_EXECUTION_LIMITS, SESSION_HISTORY_LIMITS, SessionsServiceError, createReadOnlySessionsService } from './services/sessions.js';
export { RUNTIME_DEPENDENCIES_SERVICE } from './services/runtime-dependencies.js';
export type { RuntimeDependenciesService, RuntimeDependencyInstallResult } from './services/runtime-dependencies.js';
export type {
  HistoryRevision, SessionCheckpointRef, SessionExecution, SessionExecutionInput, SessionExecutionReadOptions, SessionExecutionsOptions, SessionHistoryInfo,
  SessionHistoryOptions, SessionHistoryPage, SessionPage, SessionPageOptions, SessionRef,
  SessionsEvent, SessionsHistory, SessionsRequestOptions, SessionsService, SessionsServiceErrorCode,
} from './services/sessions.js';
export { Type } from '@earendil-works/pi-ai';
export { buildSessionContext, parseSessionEntries } from '@earendil-works/pi-coding-agent';
export type { SessionInfo } from '@earendil-works/pi-coding-agent';
export {
  associateExtensionConfig,
  configField,
  configureExtension,
  defineExtensionConfig,
  extensionConfigOverridesFromObject,
  getExtensionConfigCliOptions,
  getExtensionConfigDefinition,
  parseExtensionConfigCliValue,
  resolveExtensionConfigs,
  validateExtensionConfigValue,
} from './extension-config.js';
export type {
  ExtensionConfigCliOption,
  ExtensionConfigDefinition,
  ExtensionConfigField,
  ExtensionConfigFieldOptions,
  ExtensionConfigFields,
  ExtensionConfigOverride,
  ExtensionConfigPrimitive,
  ExtensionConfigValue,
  ExtensionConfigJsonObject,
  ExtensionConfigJsonArray,
  InferExtensionConfig,
} from './extension-config.js';
export type { ExtensionConfigWriter } from './extension-config-write.js';
export { formatCapabilitiesSection } from './capabilities.js';
export type { FelanCapability, RegisteredFelanCapability } from './capabilities.js';
export { FELAN_BASE_SYSTEM_PROMPT } from './system-prompt.js';
export type {
  ConfiguredFelanExtension,
  ExtensionPackageImporter,
  FelanExtension,
  FelanExtensionAPI,
  FelanExecutionContext,
  FelanExecutionContribution,
  FelanModelSelectionOptions,
} from './extensions.js';
export {
  createAgentCoreResourceLoader,
  runtimeToolsExtensionName,
} from './resource-loader.js';
export type { CreateAgentCoreResourceLoaderOptions } from './resource-loader.js';
export { createRuntimeCodingTools } from './tools.js';
export { extractTranscriptEvidenceEntry, extractTranscriptTextParts } from './transcript-evidence.js';
export type { TranscriptEvidenceEntry, TranscriptTextParts } from './transcript-evidence.js';
export type { RuntimeCodingToolsOptions } from './tools.js';
export {
  createAgentCoreSession,
  createAgentCoreSessionRuntime,
  createAgentCoreSessionRuntimeFactory,
} from './session.js';
export type {
  AgentCoreSessionRuntimeFactoryOptions,
  AgentCoreSessionRuntimeFactoryRequest,
  AgentCoreSessionRuntimeOptionsFactory,
  CreateAgentCoreSessionOptions,
  StreamFunction,
  ProjectInstructionsFile,
} from './session.js';
export {
  getProjectInstructions,
  PROJECT_INSTRUCTIONS_CUSTOM_TYPE,
} from './session.js';
export {
  AgentSession,
  CURRENT_SESSION_VERSION,
  DefaultResourceLoader,
  DynamicBorder,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionRuntime,
  createCodemodeExtension,
  defineTool,
  formatSkillsForPrompt,
  getAgentDir,
  loadSkillsFromDir,
  resizeImage,
  sessionEntryToContextMessages,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
export type {
  AgentSessionEvent,
  AgentSessionEventListener,
  AgentSessionRuntime,
  AgentSessionRuntimeDiagnostic,
  AgentSessionServices,
  BuildSystemPromptOptions,
  CodemodeExtensionOptions,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  CreateAgentSessionRuntimeFactory,
  CreateAgentSessionRuntimeResult,
  Extension,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
  InlineExtension,
  LoadExtensionsResult,
  ResourceDiagnostic,
  ResourceLoader,
  ResizedImage,
  SessionContext,
  SessionEntry,
  SessionMessageEntry,
  SessionStartEvent,
  Skill,
  Theme,
  ThemeColor,
  SlashCommandInfo,
  SourceInfo,
  ToolDefinition,
  ToolInfo,
} from '@earendil-works/pi-coding-agent';
export {
  InMemoryCredentialStore,
  StringEnum,
  calculateCost,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  getSupportedThinkingLevels,
  isContextOverflow,
  lazyStream,
  normalizeContext,
  uuidv7,
} from '@earendil-works/pi-ai';
export type {
  Api,
  AssistantImages,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Credential,
  CredentialInfo,
  CredentialStore,
  ImageApi,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  Model,
  ModelCost,
  ModelCostRates,
  ModelCostTier,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
  Transport,
  Usage,
} from '@earendil-works/pi-ai';
export { builtinProviders } from '@earendil-works/pi-ai/providers/all';

export { HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE } from './host-workers.js';
export type { HostWorkerOptions, HostWorker, HostWorkerLauncher, RuntimeLifecycle, RuntimeLifetime } from './host-workers.js';
