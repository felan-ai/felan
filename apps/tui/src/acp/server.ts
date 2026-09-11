import {
  PROTOCOL_VERSION,
  agent,
  methods,
  type AgentApp,
} from '@agentclientprotocol/sdk';
import { FELAN_VERSION } from '../version.js';
import {
  AcpSessionRegistry,
  type AcpSessionRegistryOptions,
} from './session-registry.js';
import { sanitizeAcpErrorMessage } from './session-updates.js';
import {
  createAcpStdioTransport,
  type AcpStdioOptions,
  type AcpStdioTransport,
} from './stdio.js';

export const ACP_TERMINAL_AUTH_METHOD = {
  id: 'felan-terminal-login',
  name: 'Log in to Felan Code',
  description: 'Configure a model provider for Felan Code in an interactive terminal.',
  type: 'terminal',
  args: ['login'],
} as const;

export interface RunLocalFelanAcpOptions extends AcpStdioOptions, AcpSessionRegistryOptions {
  readonly writeError?: (message: string) => void;
  readonly signalSource?: AcpSignalSource;
}

export interface AcpSignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface FelanAcpService {
  readonly app: AgentApp;
  dispose(): Promise<void>;
}

export function createFelanAcpService(options: AcpSessionRegistryOptions = {}): FelanAcpService {
  const sessions = new AcpSessionRegistry(options);
  const app = agent({ name: 'felan' })
    .onRequest(methods.agent.initialize, ({ params }) => {
      sessions.initialize(params.clientCapabilities ?? {});
      // The ACP Registry validator still uses this legacy metadata signal.
      const supportsTerminalAuth = params.clientCapabilities?.auth?.terminal === true
        || params.clientCapabilities?._meta?.['terminal-auth'] === true;
      return {
        protocolVersion: params.protocolVersion === PROTOCOL_VERSION
          ? params.protocolVersion
          : PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: {} },
        },
        ...(supportsTerminalAuth
          ? { authMethods: [ACP_TERMINAL_AUTH_METHOD] }
          : {}),
        agentInfo: {
          name: 'felan',
          title: 'Felan Code',
          version: FELAN_VERSION,
        },
      };
    })
    .onRequest(methods.agent.session.new, ({ params, client }) => sessions.newSession(params, client))
    .onRequest(methods.agent.session.load, async ({ params, client }) => sessions.loadSession(params, client))
    .onRequest(methods.agent.session.close, ({ params }) => sessions.closeSession(params))
    .onRequest(methods.agent.session.prompt, ({ params, client }) => sessions.prompt(params, client))
    .onNotification(methods.agent.session.cancel, ({ params }) => sessions.cancel(params.sessionId));
  return { app, dispose: () => sessions.dispose() };
}

export async function runLocalFelanAcp(options: RunLocalFelanAcpOptions = {}): Promise<number> {
  const diagnostics = options.diagnostics ?? process.stderr;
  const writeError = options.writeError ?? ((message: string) => { diagnostics.write(`${message}\n`); });
  let transport: AcpStdioTransport | undefined;
  let service: FelanAcpService | undefined;
  let removeSignalHandlers = () => {};
  let signalExitCode: number | undefined;
  let exitCode = 0;
  try {
    transport = createAcpStdioTransport(options);
    const signalSource = options.signalSource ?? process;
    service = createFelanAcpService({
      ...options,
      writeDiagnostic: options.writeDiagnostic ?? writeError,
    });
    const connection = service.app.connect(transport.stream);
    const handlers = ([
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const).map(([signal, code]) => {
      const handler = () => {
        signalExitCode ??= code;
        connection.close();
      };
      signalSource.once(signal, handler);
      return [signal, handler] as const;
    });
    removeSignalHandlers = () => {
      for (const [signal, handler] of handlers) signalSource.off(signal, handler);
    };
    await connection.closed;
  } catch (error) {
    exitCode = 1;
    writeError(sanitizeAcpErrorMessage(error));
  }
  removeSignalHandlers();
  try {
    await service?.dispose();
  } catch (error) {
    exitCode = 1;
    writeError(sanitizeAcpErrorMessage(error));
  } finally {
    transport?.restore();
  }
  return exitCode === 0 ? signalExitCode ?? 0 : exitCode;
}
