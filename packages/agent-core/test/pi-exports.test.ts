import * as piAi from '@earendil-works/pi-ai';
import type {
  Api as PiApi,
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent as PiAssistantMessageEvent,
  AssistantMessageEventStream as PiAssistantMessageEventStream,
  Context as PiContext,
  Credential as PiCredential,
  CredentialInfo as PiCredentialInfo,
  CredentialStore as PiCredentialStore,
  Model as PiModel,
  SimpleStreamOptions as PiSimpleStreamOptions,
} from '@earendil-works/pi-ai';
import * as piProviders from '@earendil-works/pi-ai/providers/all';
import * as piCodingAgent from '@earendil-works/pi-coding-agent';
import type {
  ResourceDiagnostic as PiResourceDiagnostic,
  ResourceLoader as PiResourceLoader,
  SessionContext as PiSessionContext,
  Skill as PiSkill,
  ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as agentCore from '../src/index.js';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  ResourceDiagnostic,
  ResourceLoader,
  SessionContext,
  SimpleStreamOptions,
  Skill,
  ToolDefinition,
} from '../src/index.js';

describe('Agent Core Pi exports', () => {
  it('exposes the Pi runtime values used by Felan applications', () => {
    for (const name of [
      'AgentSession',
      'CURRENT_SESSION_VERSION',
      'DefaultResourceLoader',
      'ModelRuntime',
      'SessionManager',
      'SettingsManager',
      'createAgentSessionRuntime',
      'defineTool',
      'getAgentDir',
      'loadSkillsFromDir',
    ] as const) {
      expect(agentCore[name]).toBe(piCodingAgent[name]);
    }

    for (const name of [
      'InMemoryCredentialStore',
      'createAssistantMessageEventStream',
      'getSupportedThinkingLevels',
      'isContextOverflow',
      'lazyStream',
      'uuidv7',
    ] as const) {
      expect(agentCore[name]).toBe(piAi[name]);
    }

    expect(agentCore.builtinProviders).toBe(piProviders.builtinProviders);
  });

  it('exposes the Pi types used by Felan applications', () => {
    expectTypeOf<Api>().toEqualTypeOf<PiApi>();
    expectTypeOf<AssistantMessage>().toEqualTypeOf<PiAssistantMessage>();
    expectTypeOf<AssistantMessageEvent>().toEqualTypeOf<PiAssistantMessageEvent>();
    expectTypeOf<AssistantMessageEventStream>().toEqualTypeOf<PiAssistantMessageEventStream>();
    expectTypeOf<Context>().toEqualTypeOf<PiContext>();
    expectTypeOf<Credential>().toEqualTypeOf<PiCredential>();
    expectTypeOf<CredentialInfo>().toEqualTypeOf<PiCredentialInfo>();
    expectTypeOf<CredentialStore>().toEqualTypeOf<PiCredentialStore>();
    expectTypeOf<Model<Api>>().toEqualTypeOf<PiModel<PiApi>>();
    expectTypeOf<ResourceDiagnostic>().toEqualTypeOf<PiResourceDiagnostic>();
    expectTypeOf<ResourceLoader>().toEqualTypeOf<PiResourceLoader>();
    expectTypeOf<SessionContext>().toEqualTypeOf<PiSessionContext>();
    expectTypeOf<SimpleStreamOptions>().toEqualTypeOf<PiSimpleStreamOptions>();
    expectTypeOf<Skill>().toEqualTypeOf<PiSkill>();
    expectTypeOf<ToolDefinition>().toEqualTypeOf<PiToolDefinition>();
  });
});
