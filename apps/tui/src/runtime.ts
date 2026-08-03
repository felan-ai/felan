import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AGENT_CORE_VERSION,
  HostAgentRuntime,
  ModelRuntime,
  SessionManager,
  createAgentCoreSession,
  createAgentCoreSessionRuntimeFactory,
  createAgentSessionRuntime,
  type AgentRuntime,
  type AgentSessionHost,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionPackageImporter,
} from '@felan-ai/agent-core';
import {
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
} from '@earendil-works/pi-coding-agent';
import { importLocalExtension, localExtensionPackages } from './extensions.js';
import { createLocalSettingsManager } from './settings.js';

export interface CreateLocalSessionRuntimeFactoryOptions {
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly extensionPackages?: readonly string[];
  readonly importExtension?: ExtensionPackageImporter;
  readonly runtimeFactory?: (cwd: string) => AgentRuntime;
}

export interface CreateLocalFelanRuntimeOptions {
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly continueRecent?: boolean;
  readonly sessionManager?: SessionManager;
  readonly modelRuntime?: ModelRuntime;
  readonly sessionDir?: string;
  readonly runtimeFactory?: (cwd: string) => AgentRuntime;
}

export function getLocalAgentDir(): string {
  return resolve(process.env.FELAN_AGENT_DIR ?? join(homedir(), '.felan', 'agent'));
}

export function createLocalSessionRuntimeFactory(
  options: CreateLocalSessionRuntimeFactoryOptions,
): CreateAgentSessionRuntimeFactory {
  const createCoreRuntime = createAgentCoreSessionRuntimeFactory(async ({ cwd }) => {
    const settingsManager = createLocalSettingsManager(cwd, options.agentDir);
    const modelPatterns = settingsManager.getEnabledModels();
    const modelScope = modelPatterns && modelPatterns.length > 0
      ? await resolveModelScopeWithDiagnostics(modelPatterns, options.modelRuntime)
      : { scopedModels: [], diagnostics: [] };

    return {
      applicationKind: 'tui',
      runtime: options.runtimeFactory?.(cwd) ?? new HostAgentRuntime(cwd),
      host: createLocalSessionHost(options, cwd),
      extensionPackages: options.extensionPackages ?? localExtensionPackages,
      importExtension: options.importExtension ?? importLocalExtension,
      modelRuntime: options.modelRuntime,
      settingsManager,
      ...(modelScope.scopedModels.length === 0 ? {} : { scopedModels: modelScope.scopedModels }),
    };
  });

  return async (request) => {
    const result = await createCoreRuntime(request);
    const settingsErrors = result.services.settingsManager.drainErrors();
    const modelPatterns = result.services.settingsManager.getEnabledModels();
    const modelScope = modelPatterns && modelPatterns.length > 0
      ? await resolveModelScopeWithDiagnostics(modelPatterns, options.modelRuntime)
      : { diagnostics: [] };

    return {
      ...result,
      diagnostics: [
        { type: 'info', message: `Agent Core version: ${AGENT_CORE_VERSION}` },
        ...result.diagnostics,
        ...modelScope.diagnostics,
        ...settingsErrors.map(({ scope, error }) => ({
          type: 'warning' as const,
          message: `${scope} settings: ${error.message}`,
        })),
      ],
    };
  };
}

export function createLocalSessionHost(
  options: CreateLocalSessionRuntimeFactoryOptions,
  cwd: string,
): AgentSessionHost {
  return {
    createChildSession: async (request) => {
      const sessionManager = SessionManager.inMemory(cwd);
      const childSessionId = sessionManager.getSessionId();
      const resolvedModel = request.model
        ? resolveCliModel({ cliModel: request.model, modelRuntime: options.modelRuntime })
        : undefined;
      if (resolvedModel?.error) {
        return {
          ok: false,
          sessionId: childSessionId,
          status: 'failed',
          error: resolvedModel.error,
        };
      }

      const created = await createAgentCoreSession({
        applicationKind: 'tui',
        runtime: options.runtimeFactory?.(cwd) ?? new HostAgentRuntime(cwd),
        host: createLocalSessionHost(options, cwd),
        extensionPackages: options.extensionPackages ?? localExtensionPackages,
        importExtension: options.importExtension ?? importLocalExtension,
        modelRuntime: options.modelRuntime,
        settingsManager: createLocalSettingsManager(cwd, options.agentDir),
        sessionManager,
        appendSystemPrompt: [`You are the ${request.personaId} child agent.`],
        ...(resolvedModel?.model === undefined ? {} : { model: resolvedModel.model }),
        ...(resolvedModel?.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: resolvedModel.thinkingLevel }),
      });
      try {
        await created.session.bindExtensions({ mode: 'print' });
      } catch (error) {
        created.session.dispose();
        throw error;
      }

      const runChild = async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        if (request.timeoutMinutes) {
          timeout = setTimeout(() => void created.session.abort(), request.timeoutMinutes * 60_000);
          timeout.unref();
        }

        try {
          await created.session.prompt(request.prompt);
          let assistant: Extract<(typeof created.session.messages)[number], { role: 'assistant' }> | undefined;
          for (let index = created.session.messages.length - 1; index >= 0; index -= 1) {
            const message = created.session.messages[index];
            if (message?.role === 'assistant') {
              assistant = message;
              break;
            }
          }
          if (!assistant) {
            return {
              ok: false,
              sessionId: childSessionId,
              status: 'failed' as const,
              error: 'Child session completed without an assistant response',
            };
          }
          if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
            return {
              ok: false,
              sessionId: childSessionId,
              status: 'failed' as const,
              error: assistant.errorMessage ?? `Child session ${assistant.stopReason}`,
            };
          }
          const result = assistant.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          return {
            ok: true,
            sessionId: childSessionId,
            status: 'completed' as const,
            result,
          };
        } catch (error) {
          return {
            ok: false,
            sessionId: childSessionId,
            status: 'failed' as const,
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          if (timeout) clearTimeout(timeout);
          created.session.dispose();
        }
      };

      if (!request.block) {
        void runChild();
        return {
          ok: true,
          sessionId: childSessionId,
          status: 'running',
          message: 'Child session started',
        };
      }
      return runChild();
    },
  };
}

export async function createLocalModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
  });
}

export async function createLocalFelanRuntime(
  options: CreateLocalFelanRuntimeOptions = {},
) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolve(options.agentDir ?? getLocalAgentDir());
  await mkdir(agentDir, { recursive: true });
  const modelRuntime = options.modelRuntime ?? await createLocalModelRuntime(agentDir);
  const startupSettings = createLocalSettingsManager(cwd, agentDir);
  const sessionDir = options.sessionDir ?? startupSettings.getSessionDir();
  const sessionManager = options.sessionManager
    ?? (options.continueRecent
      ? SessionManager.continueRecent(cwd, sessionDir)
      : SessionManager.create(cwd, sessionDir));
  const createRuntime = createLocalSessionRuntimeFactory({
    agentDir,
    modelRuntime,
    ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
  });

  return createAgentSessionRuntime(createRuntime, {
    cwd: sessionManager.getCwd(),
    agentDir,
    sessionManager,
  });
}
