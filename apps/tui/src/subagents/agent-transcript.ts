import {
  AssistantMessageComponent,
  CompactionSummaryMessageComponent,
  getMarkdownTheme,
  keyHint,
  keyText,
  ToolExecutionComponent,
  UserMessageComponent,
  type AgentSession,
  type AgentSessionEvent,
  type KeybindingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  Spacer,
  type Component,
  type MarkdownTheme,
  type TUI,
} from '@earendil-works/pi-tui';
import { getLocalToolDisplayMode } from '../settings.js';
import { createToolActivitySessionView } from '../tool-activity/runtime-view.js';
import { ToolActivityState } from '../tool-activity/state.js';
import { renderThinkingGroupMarkdown } from '../thinking-groups.js';

type AgentMessage = AgentSession['messages'][number];
type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>;
type CompactionSummaryMessage = Extract<AgentMessage, { role: 'compactionSummary' }>;
type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>;
type UserMessage = Extract<AgentMessage, { role: 'user' }>;

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
  readonly #assistantComponents = new Map<string, AssistantMessageComponent>();
  readonly #toolComponents = new Map<string, ToolExecutionComponent>();
  readonly #pendingToolIds = new Set<string>();
  readonly #renderedUserMessages = new Set<string>();
  readonly #renderedCompactionMessages = new Set<string>();
  readonly #expandableComponents = new Set<{ setExpanded(expanded: boolean): void }>();
  #attachment: Attachment | undefined;
  #activeAssistantKey: string | undefined;
  #hideThinkingBlock = false;
  #toolsExpanded = false;
  #showImages = true;
  #imageWidthCells = 60;

  constructor(
    private readonly tui: TUI,
    private readonly keybindings: KeybindingsManager,
  ) {
    this.#markdownTheme = getMarkdownTheme();
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

  detach(): void {
    const attachment = this.#attachment;
    this.#attachment = undefined;
    if (attachment && !attachment.released) {
      attachment.released = true;
      const unsubscribe = attachment.unsubscribe;
      attachment.unsubscribe = undefined;
      unsubscribe?.();
    }
    attachment?.toolActivityState.dispose();
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

  getToggleHints(): { tools: string; thinking: string } {
    return {
      tools: keyHint('app.tools.expand', this.#toolsExpanded ? 'collapse tools' : 'expand tools'),
      thinking: keyHint('app.thinking.toggle', this.#hideThinkingBlock ? 'show thinking' : 'hide thinking'),
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

  #replayMessage(message: AgentMessage): void {
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
    this.#container.addChild(new UserMessageComponent(text, this.#markdownTheme));
  }

  #startAssistant(message: AssistantMessage): void {
    const key = this.#assistantKey(message);
    this.#activeAssistantKey = key;
    this.#addAssistantMessage(message);
  }

  #updateAssistant(message: AssistantMessage): void {
    const key = this.#activeAssistantKey ?? this.#assistantKey(message);
    const component = this.#assistantComponents.get(key);
    if (!component) {
      this.#startAssistant(message);
      return;
    }
    component.updateContent(message);
    this.#activeAssistantKey = key;
    this.#addToolsFromAssistant(message);
  }

  #endAssistant(message: AssistantMessage): void {
    const key = this.#activeAssistantKey ?? this.#assistantKey(message);
    const component = this.#assistantComponents.get(key);
    if (component) component.updateContent(message);
    else this.#addAssistantMessage(message);

    const toolIds = this.#addToolsFromAssistant(message);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      this.#failTools(toolIds, this.#assistantError(message));
    } else {
      for (const toolCallId of toolIds) this.#toolComponents.get(toolCallId)?.setArgsComplete();
    }
    this.#activeAssistantKey = undefined;
  }

  #addAssistantMessage(message: AssistantMessage): Set<string> {
    const key = this.#assistantKey(message);
    let component = this.#assistantComponents.get(key);
    if (!component) {
      component = new AssistantMessageComponent(
        message,
        this.#hideThinkingBlock,
        this.#markdownTheme,
        'Thinking...',
        undefined,
        [renderThinkingGroupMarkdown],
      );
      this.#assistantComponents.set(key, component);
      this.#container.addChild(component);
    } else {
      component.updateContent(message);
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

  #addTool(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
    const existing = this.#toolComponents.get(toolCallId);
    if (existing) return existing;

    const session = this.#attachment?.session;
    if (!session) throw new Error('Cannot render a tool without an attached session');
    const component = new ToolExecutionComponent(
      toolName,
      toolCallId,
      args,
      { showImages: this.#showImages, imageWidthCells: this.#imageWidthCells },
      this.#attachment?.sessionView.getToolDefinition(toolName),
      this.tui,
      this.#attachment?.sessionView.sessionManager.getCwd() ?? session.sessionManager.getCwd(),
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
    const component = new CompactionSummaryMessageComponent(message, this.#markdownTheme);
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
