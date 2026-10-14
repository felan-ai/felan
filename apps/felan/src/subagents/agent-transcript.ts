import {
  keyText,
  type AgentSession,
  type AgentSessionEvent,
  type KeybindingsManager,
  type ToolDefinition,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  Markdown,
  Spacer,
  Text,
  type Component,
  type MarkdownTheme,
  type TUI,
} from '@earendil-works/pi-tui';
import { getLocalToolDisplayMode } from '../tool-activity/mode.js';
import type { AgentViewTranscript } from './types.js';
import { createToolActivitySessionView } from '../tool-activity/runtime-view.js';
import { createToolActivityDisplayDefinition } from '../tool-activity/presentation.js';
import { ToolActivityState } from '../tool-activity/state.js';
import { clientMarkdownTheme, defaultClientTheme } from '../tui/theme.js';
import { TranscriptAssistant, TranscriptCompaction, TranscriptTool } from './transcript-components.js';
import { renderThinkingGroupMarkdown } from '../thinking-groups.js';
import { clientMarkdownTransform, type MermaidMode } from '../tui/markdown.js';
import { ShellExecution } from '../tui/shell-execution.js';
import { completionNotices, SubagentCompletionComponent } from './completion-presentation.js';
import { SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE } from '../execution-completion.js';
import { BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE } from '@felan-ai/ext-background-bash/data';
import { BackgroundBashCompletionComponent, completionJob } from '../tui/renderers/processes/completion-message.js';
import {
  compactionMethodForMessage,
  type CompactionMethodLabel,
} from '../compaction-presentation.js';

type AgentMessage = AgentSession['messages'][number];
type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>;
type CompactionSummaryMessage = Extract<AgentMessage, { role: 'compactionSummary' }>;
type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>;
type UserMessage = Extract<AgentMessage, { role: 'user' }>;

export type AgentToolPresentation = Pick<ToolDefinition<any, any, any>, 'renderCall' | 'renderResult' | 'renderShell'>;

interface Attachment {
  session: AgentSession;
  sessionView: AgentSession;
  toolActivityState: ToolActivityState;
  unsubscribe: (() => void) | undefined;
  released: boolean;
}

export class AgentTranscript implements Component {
  readonly #container = new Container();
  readonly #markdownTheme: MarkdownTheme;
  readonly #assistantComponents = new Map<string, TranscriptAssistant>();
  readonly #toolComponents = new Map<string, TranscriptTool>();
  readonly #theme: () => Theme;
  readonly #pendingToolIds = new Set<string>();
  readonly #renderedUserMessages = new Set<string>();
  readonly #renderedCompactionMessages = new Set<string>();
  readonly #expandableComponents = new Set<{ setExpanded(expanded: boolean): void }>();
  #attachment: Attachment | undefined;
  #snapshotToolActivityState: ToolActivityState | undefined;
  #snapshotCwd: string | undefined;
  #projectionAgent: string | undefined;
  #projectionHideThinking: boolean | undefined;
  #projectedCompactions = new WeakMap<object, CompactionMethodLabel>();
  #activeAssistantKey: string | undefined;
  #hideThinkingBlock = false;
  #toolsExpanded = false;
  #showImages = true;
  #imageWidthCells = 60;
  #outputPad: number = 1;
  #mermaid: MermaidMode = 'streaming';

  constructor(
    private readonly tui: TUI,
    private readonly keybindings: Pick<KeybindingsManager, 'matches'>,
    private readonly toolPresentation?: (name: string) => AgentToolPresentation | undefined,
    theme?: () => Theme,
  ) {
    const initial = theme ? undefined : defaultClientTheme();
    this.#theme = theme ?? (() => initial!);
    this.#markdownTheme = clientMarkdownTheme(this.#theme);
  }

  attach(session: AgentSession): void {
    this.detach();

    const toolActivityState = new ToolActivityState(
      getLocalToolDisplayMode(session.settingsManager),
      false,
    );
    const attachment: Attachment = {
      session,
      sessionView: createToolActivitySessionView(session, toolActivityState),
      toolActivityState,
      unsubscribe: undefined,
      released: false,
    };
    const queuedEvents: AgentSessionEvent[] = [];
    let replaying = true;
    this.#attachment = attachment;

    try {
      toolActivityState.attach(session);
      attachment.unsubscribe = session.subscribe((event) => {
        if (this.#attachment !== attachment) return;
        if (replaying) queuedEvents.push(event);
        else this.#handleEvent(event);
      });

      this.#hideThinkingBlock = session.settingsManager.getHideThinkingBlock();
      this.#showImages = session.settingsManager.getShowImages();
      this.#imageWidthCells = session.settingsManager.getImageWidthCells();
      this.#outputPad = session.settingsManager.getOutputPad();
      this.#mermaid = session.settingsManager.getMermaidRenderingMode();
      this.#rebuildFromSession(session);

      replaying = false;
      for (const event of queuedEvents) this.#handleEvent(event);
      this.tui.requestRender();
    } catch (error) {
      replaying = false;
      if (this.#attachment === attachment) this.detach();
      throw error;
    }
  }

  showSnapshot(messages: readonly AgentMessage[], cwd: string): void {
    this.detach();
    this.#snapshotCwd = cwd;
    const toolActivityState = new ToolActivityState('grouped');
    toolActivityState.showSnapshot(messages, cwd);
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const content of message.content) {
        if (content.type !== 'toolCall' || toolActivityState.definition(content.name)) continue;
        toolActivityState.rememberDefinition(content.name, snapshotToolDefinition(content.name));
      }
    }
    this.#snapshotToolActivityState = toolActivityState;
    this.#hideThinkingBlock = false;
    this.#showImages = false;
    this.#mermaid = 'streaming';
    for (const message of messages) this.#replayMessage(message);
    this.#failTools(this.#pendingToolIds, 'No retained tool result.');
    this.tui.requestRender();
  }

  showProjection(projection: AgentViewTranscript): void {
    const initialize = this.#projectionAgent !== projection.agentId || this.#projectionHideThinking !== projection.settings.hideThinking;
    this.detach();
    this.#projectionAgent = projection.agentId;
    this.#projectionHideThinking = projection.settings.hideThinking;
    this.#snapshotCwd = projection.cwd;
    const { settings, messages, streaming } = projection;
    if (initialize) this.#hideThinkingBlock = settings.hideThinking;
    this.#showImages = settings.showImages;
    this.#imageWidthCells = settings.imageWidthCells;
    this.#outputPad = settings.outputPad;
    this.#mermaid = settings.mermaid ?? 'streaming';
    const pendingToolCalls = new Set(projection.pendingTools);
    const toolActivityState = new ToolActivityState(settings.toolMode, false);
    toolActivityState.showSnapshot(messages, projection.cwd, { pendingToolCalls, ...(streaming ? { streaming } : {}) });
    for (const message of [...messages, ...(streaming ? [streaming] : [])]) {
      if (message.role !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type !== 'toolCall' || toolActivityState.definition(part.name)) continue;
        toolActivityState.rememberDefinition(part.name, snapshotToolDefinition(part.name, this.toolPresentation?.(part.name)));
      }
    }
    this.#snapshotToolActivityState = toolActivityState;
    for (const item of projection.compactions ?? []) {
      const message = messages[item.message]; if (message) this.#projectedCompactions.set(message, item.method);
    }
    for (let index = 0; index <= messages.length; index++) {
      for (const fallback of projection.fallbacks ?? []) if (fallback.before === index) this.#container.addChild(new Markdown(fallback.text, this.#outputPad, 0, this.#markdownTheme));
      if (index < messages.length) this.#replayMessage(messages[index]!, projection.runningShells?.includes(index));
    }
    if (streaming?.role === 'assistant') this.#startAssistant(streaming);
    else for (const part of projection.streamingContent ?? []) {
      this.#container.addChild(new Spacer(1));
      if (part.type === 'text') this.#container.addChild(new Markdown(part.text, this.#outputPad, 0, this.#markdownTheme, undefined,
        { transform: clientMarkdownTransform(this.#theme(), this.#mermaid, true) }));
      else if (this.#hideThinkingBlock) this.#container.addChild(new Text(this.#theme().fg('thinkingText', this.#theme().italic('Thinking...')), this.#outputPad, 0));
      else this.#container.addChild(new Markdown(part.thinking, this.#outputPad, 0, this.#markdownTheme,
        { color: value => this.#theme().fg('thinkingText', value), italic: true },
        { transform: (value, width) => renderThinkingGroupMarkdown(value, { messageType: 'assistant-thinking', isStreaming: true, availableWidth: width }) }));
    }
    for (const id of pendingToolCalls) this.#toolComponents.get(id)?.markExecutionStarted();
    for (const tool of projection.tools ?? []) {
      if (!this.#pendingToolIds.has(tool.id)) continue;
      const output = `${tool.output}${tool.truncated ? '\n[Tool output truncated]' : ''}`;
      toolActivityState.projectTool(tool.id, tool.state, output);
      this.#toolComponents.get(tool.id)?.updateResult({ content: [{ type: 'text', text: output }], isError: tool.state === 'failed' || tool.state === 'interrupted' }, tool.state === 'running');
      if (tool.state !== 'running') this.#pendingToolIds.delete(tool.id);
    }
    this.tui.requestRender();
  }

  detach(): void {
    const attachment = this.#attachment;
    this.#attachment = undefined;
    this.#snapshotCwd = undefined;
    this.#projectionAgent = undefined;
    this.#projectionHideThinking = undefined;
    this.#projectedCompactions = new WeakMap();
    if (attachment && !attachment.released) {
      attachment.released = true;
      const unsubscribe = attachment.unsubscribe;
      attachment.unsubscribe = undefined;
      unsubscribe?.();
    }
    attachment?.toolActivityState.dispose();
    this.#snapshotToolActivityState?.dispose();
    this.#snapshotToolActivityState = undefined;
    this.#clear();
  }

  dispose(): void {
    this.detach();
  }

  render(width: number): string[] {
    return this.#container.render(width);
  }

  invalidate(): void {
    this.#container.invalidate();
  }

  handleInput(data: string): boolean {
    if (this.keybindings.matches(data, 'app.tools.expand')) {
      this.#setToolsExpanded(!this.#toolsExpanded);
      return true;
    }
    if (this.keybindings.matches(data, 'app.thinking.toggle')) {
      this.#setThinkingHidden(!this.#hideThinkingBlock);
      return true;
    }
    return false;
  }

  get toolsExpanded(): boolean { return this.#toolsExpanded; }

  getToggleHints(): { tools: string; thinking: string } {
    return {
      tools: `${keyText('app.tools.expand')} ${this.#toolsExpanded ? 'collapse tools' : 'expand tools'}`,
      thinking: `${keyText('app.thinking.toggle')} ${this.#hideThinkingBlock ? 'show thinking' : 'hide thinking'}`,
    };
  }

  #setToolsExpanded(expanded: boolean): void {
    this.#toolsExpanded = expanded;
    for (const component of this.#expandableComponents) component.setExpanded(expanded);
    this.tui.requestRender();
  }

  #setThinkingHidden(hidden: boolean): void {
    this.#hideThinkingBlock = hidden;
    this.#attachment?.session.settingsManager.setHideThinkingBlock(hidden);
    for (const component of this.#assistantComponents.values()) component.setHideThinkingBlock(hidden);
    this.tui.requestRender();
  }

  #clear(): void {
    this.#container.clear();
    for (const component of this.#toolComponents.values()) component.dispose();
    this.#assistantComponents.clear();
    this.#toolComponents.clear();
    this.#pendingToolIds.clear();
    this.#renderedUserMessages.clear();
    this.#renderedCompactionMessages.clear();
    this.#expandableComponents.clear();
    this.#activeAssistantKey = undefined;
  }

  #rebuildFromSession(session: AgentSession): void {
    const messages = [...session.messages];
    const streamingMessage = session.state.streamingMessage;
    const pendingToolCalls = new Set(session.state.pendingToolCalls);
    this.#clear();

    for (const message of messages) this.#replayMessage(message);
    if (streamingMessage?.role === 'assistant') this.#startAssistant(streamingMessage);
    for (const toolCallId of pendingToolCalls) {
      const component = this.#toolComponents.get(toolCallId);
      if (component) {
        this.#pendingToolIds.add(toolCallId);
        component.markExecutionStarted();
      }
    }
  }

  #replayMessage(message: AgentMessage, runningShell = false): void {
    if (message.role === 'bashExecution') {
      const component = new ShellExecution(message, runningShell, this.#outputPad, this.#theme);
      component.setExpanded(this.#toolsExpanded);
      this.#expandableComponents.add(component);
      this.#container.addChild(component);
      return;
    }
    if (message.role === 'custom' && message.display) {
      const text = typeof message.content === 'string' ? message.content : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
      if (message.customType !== SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE && message.customType !== BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE) return;
      this.#container.addChild(new Spacer(1));
      this.#container.addChild({
        render: width => (message.customType === SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE
          ? new SubagentCompletionComponent(completionNotices(message.details), text, this.#toolsExpanded, this.#outputPad, this.#theme())
          : new BackgroundBashCompletionComponent(completionJob(message.details), text, this.#toolsExpanded, this.#outputPad, this.#theme())).render(width),
        invalidate() {},
      });
      return;
    }
    if (message.role === 'user') {
      this.#addUserMessage(message);
      return;
    }
    if (message.role === 'assistant') {
      const toolIds = this.#addAssistantMessage(message);
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        this.#failTools(toolIds, this.#assistantError(message));
      } else {
        for (const toolCallId of toolIds) this.#toolComponents.get(toolCallId)?.setArgsComplete();
      }
      return;
    }
    if (message.role === 'toolResult') this.#applyToolResult(message);
    else if (message.role === 'compactionSummary') this.#addCompactionSummary(message);
  }

  #handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'user') this.#addUserMessage(event.message);
        else if (event.message.role === 'assistant') this.#startAssistant(event.message);
        else if (event.message.role === 'toolResult') this.#applyToolResult(event.message);
        else return;
        break;
      case 'message_update':
        if (event.message.role !== 'assistant') return;
        this.#updateAssistant(event.message);
        break;
      case 'message_end':
        if (event.message.role !== 'assistant') return;
        this.#endAssistant(event.message);
        break;
      case 'tool_execution_start': {
        const component = this.#addTool(event.toolName, event.toolCallId, event.args);
        this.#pendingToolIds.add(event.toolCallId);
        component.markExecutionStarted();
        break;
      }
      case 'tool_execution_update': {
        const component = this.#addTool(event.toolName, event.toolCallId, event.args);
        this.#pendingToolIds.add(event.toolCallId);
        component.updateResult({ ...event.partialResult, isError: false }, true);
        break;
      }
      case 'tool_execution_end': {
        const component = this.#addTool(event.toolName, event.toolCallId, {});
        component.updateResult({ ...event.result, isError: event.isError });
        this.#pendingToolIds.delete(event.toolCallId);
        break;
      }
      case 'compaction_end':
        if (event.aborted || !event.result || !this.#attachment) return;
        this.#rebuildFromSession(this.#attachment.session);
        this.#addCompactionSummary({
          role: 'compactionSummary',
          summary: event.result.summary,
          tokensBefore: event.result.tokensBefore,
          timestamp: Date.now(),
        });
        break;
      default:
        return;
    }
    this.tui.requestRender();
  }

  #addUserMessage(message: UserMessage): void {
    const text = this.#userText(message);
    const key = `${message.timestamp}:${text}`;
    if (!text || this.#renderedUserMessages.has(key)) return;
    this.#renderedUserMessages.add(key);
    this.#container.addChild(new Markdown(text, this.#outputPad, 1, this.#markdownTheme, {
      color: value => this.#theme().fg('userMessageText', value), bgColor: value => this.#theme().bg('userMessageBg', value),
    }, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true }));
  }

  #startAssistant(message: AssistantMessage): void {
    const key = this.#assistantKey(message);
    this.#activeAssistantKey = key;
    this.#addAssistantMessage(message, true);
  }

  #updateAssistant(message: AssistantMessage): void {
    const key = this.#activeAssistantKey ?? this.#assistantKey(message);
    const component = this.#assistantComponents.get(key);
    if (!component) {
      this.#startAssistant(message);
      return;
    }
    component.updateContent(message, true);
    this.#activeAssistantKey = key;
    this.#addToolsFromAssistant(message);
  }

  #endAssistant(message: AssistantMessage): void {
    const key = this.#activeAssistantKey ?? this.#assistantKey(message);
    const component = this.#assistantComponents.get(key);
    if (component) component.updateContent(message, false);
    else this.#addAssistantMessage(message);

    const toolIds = this.#addToolsFromAssistant(message);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      this.#failTools(toolIds, this.#assistantError(message));
    } else {
      for (const toolCallId of toolIds) this.#toolComponents.get(toolCallId)?.setArgsComplete();
    }
    this.#activeAssistantKey = undefined;
  }

  #addAssistantMessage(message: AssistantMessage, isStreaming = false): Set<string> {
    const key = this.#assistantKey(message);
    let component = this.#assistantComponents.get(key);
    if (!component) {
      component = new TranscriptAssistant(
        message,
        this.#hideThinkingBlock,
        this.#markdownTheme,
        this.#outputPad,
        this.#theme,
        this.#mermaid,
        isStreaming,
      );
      this.#assistantComponents.set(key, component);
      this.#container.addChild(component);
    } else {
      component.updateContent(message, isStreaming);
    }
    return this.#addToolsFromAssistant(message);
  }

  #addToolsFromAssistant(message: AssistantMessage): Set<string> {
    const toolIds = new Set<string>();
    for (const content of message.content) {
      if (content.type !== 'toolCall') continue;
      toolIds.add(content.id);
      this.#addTool(content.name, content.id, content.arguments).updateArgs(content.arguments);
    }
    return toolIds;
  }

  #addTool(toolName: string, toolCallId: string, args: unknown): TranscriptTool {
    const existing = this.#toolComponents.get(toolCallId);
    if (existing) return existing;

    const cwd = this.#attachment?.sessionView.sessionManager.getCwd() ?? this.#snapshotCwd;
    if (cwd === undefined) throw new Error('Cannot render a tool without a session or snapshot');
    let definition = this.#attachment?.sessionView.getToolDefinition(toolName);
    if (!definition && this.#snapshotToolActivityState) {
      const state = this.#snapshotToolActivityState;
      const original = state.definition(toolName);
      definition = original && state.mode !== 'full' && !state.isRendererPreserved(toolName)
        ? createToolActivityDisplayDefinition(state, toolName, original)
        : original;
    }
    const component = new TranscriptTool(
      toolName,
      toolCallId,
      args,
      { showImages: this.#showImages, imageWidthCells: this.#imageWidthCells, outputPad: this.#outputPad },
      definition,
      this.tui,
      cwd,
      this.#theme,
      () => keyText('app.tools.expand'),
    );
    component.setExpanded(this.#toolsExpanded);
    this.#toolComponents.set(toolCallId, component);
    this.#expandableComponents.add(component);
    this.#pendingToolIds.add(toolCallId);
    this.#container.addChild(component);
    return component;
  }

  #applyToolResult(message: ToolResultMessage): void {
    const component = this.#toolComponents.get(message.toolCallId);
    if (!component) return;
    component.updateResult(message);
    this.#pendingToolIds.delete(message.toolCallId);
  }

  #addCompactionSummary(message: CompactionSummaryMessage): void {
    const key = `${message.tokensBefore}:${message.summary}`;
    if (this.#renderedCompactionMessages.has(key)) return;
    this.#renderedCompactionMessages.add(key);
    const method = this.#attachment === undefined
      ? this.#projectedCompactions.get(message)
      : compactionMethodForMessage(this.#attachment.session.sessionManager.getBranch(), message);
    const component = new TranscriptCompaction(message, this.#markdownTheme, this.#theme, this.#outputPad, () => keyText('app.tools.expand'), method);
    component.setExpanded(this.#toolsExpanded);
    this.#expandableComponents.add(component);
    this.#container.addChild(new Spacer(1));
    this.#container.addChild(component);
  }

  #failTools(toolIds: Iterable<string>, errorMessage: string): void {
    for (const toolCallId of toolIds) {
      if (!this.#pendingToolIds.has(toolCallId)) continue;
      this.#toolComponents.get(toolCallId)?.updateResult({
        content: [{ type: 'text', text: errorMessage }],
        isError: true,
      });
      this.#pendingToolIds.delete(toolCallId);
    }
  }

  #assistantError(message: AssistantMessage): string {
    if (message.stopReason === 'aborted') return message.errorMessage || 'Operation aborted';
    return message.errorMessage || 'Error';
  }

  #assistantKey(message: AssistantMessage): string {
    return `${message.timestamp}:${message.provider}:${message.model}`;
  }

  #userText(message: UserMessage): string {
    if (typeof message.content === 'string') return message.content;
    return message.content
      .filter((content) => content.type === 'text')
      .map((content) => content.text)
      .join('');
  }
}

function snapshotToolDefinition(name: string, presentation?: AgentToolPresentation): ToolDefinition<any, any, any> {
  return {
    name,
    label: name,
    description: 'Read-only transcript tool call.',
    parameters: { type: 'object' } as never,
    ...(presentation?.renderCall === undefined ? {} : { renderCall: presentation.renderCall }),
    ...(presentation?.renderResult === undefined ? {} : { renderResult: presentation.renderResult }),
    ...(presentation?.renderShell === undefined ? {} : { renderShell: presentation.renderShell }),
    async execute() {
      throw new Error('Transcript tool calls are read-only');
    },
  };
}
