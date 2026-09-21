import type { Classifier, ClassifierAnswer, ClassifierEvaluationMetadata } from '@felan-ai/agent-core';
import {
  COMPACTION_CHOICE_CRITERIA,
  type CompactionClassifierChoice,
  type CompactionClassifierChoiceAnswer,
  type CompactionClassifierQuestion,
} from './classifier.js';
import { DEFAULT_EXTRACTION_BOUNDS, utf8Bytes } from './internal/bounds.js';
import type { EvidenceBundle, EvidenceItem, PreparedSpan } from './internal/contracts.js';

export const JEV_PRUNE_HEAD_CHARS = 300;
export const JEV_PRUNE_EXACT_KEEP = 0.35;
export const JEV_PRUNE_OBSOLETE_CONFIDENCE = 0.6;
export const JEV_PRUNE_TINY_BYTES = 90;
export const JEV_PRUNE_RESULT_HEAD_CHARS = 120;

export type EvidencePruneSkipReason = 'no-classifier' | 'no-candidates' | 'classifier-failed';
export type EvidencePruneAction = 'keep' | 'shorten' | 'drop';
export type EvidencePruneTrigger = 'manual' | 'threshold' | 'overflow';

export interface EvidencePruneDecision {
  readonly id: string;
  readonly action: EvidencePruneAction;
  readonly reason: 'exact_contents' | 'outcome_only' | 'obsolete' | 'missing';
  readonly toolName?: string;
  readonly choice?: CompactionClassifierChoice;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Partial<Record<CompactionClassifierChoice, number>>>;
}

export type EvidencePruneReport =
  | { readonly status: 'off' }
  | { readonly status: 'skipped'; readonly reason: EvidencePruneSkipReason }
  | {
    readonly status: 'ran';
    readonly kept: number;
    readonly shortened: number;
    readonly dropped: number;
    readonly asked: number;
    readonly decisions: readonly EvidencePruneDecision[];
    readonly classifier?: ClassifierEvaluationMetadata;
  };

export interface EvidencePruneContext {
  readonly trigger: EvidencePruneTrigger;
  readonly customInstructions?: string;
  readonly previousSummary?: string;
  readonly signal?: AbortSignal;
}

export type EvidencePruneLeftoverReason = 'unasked' | 'tiny';

export interface EvidencePruneLeftover {
  readonly id: string;
  readonly bytes: number;
  readonly action: EvidencePruneAction;
  readonly reason: EvidencePruneLeftoverReason;
  readonly toolName?: string;
}

export interface EvidencePruneDebug {
  readonly trigger: EvidencePruneTrigger;
  readonly inFlight: boolean;
  readonly candidates: number;
  readonly bulky: number;
  readonly tiny: number;
  readonly leftover: number;
  readonly leftovers: readonly EvidencePruneLeftover[];
  readonly report: EvidencePruneReport;
  readonly criteria?: typeof COMPACTION_CHOICE_CRITERIA;
  readonly state?: unknown;
  readonly questions?: Readonly<Record<string, { readonly instructions: string }>>;
  readonly answers?: unknown;
  readonly error?: string;
}

const RESULT_KINDS = new Set<EvidenceItem['kind']>(['observation', 'command', 'test']);
const NEVER_DROP_KINDS = new Set<EvidenceItem['kind']>(['command', 'test']);
const STATE_CONTEXT = [
  'A coding-agent session is being compacted. A summarizer will write a checkpoint',
  '(goal, constraints, progress, decisions, next steps, critical context) from `history`,',
  'and the agent continues from that checkpoint. Items with an id may be dropped or',
  'shortened before the summarizer sees them. The agent can re-run any tool afterwards.',
].join(' ');

interface CandidateGroup {
  key: string;
  id: string;
  call?: EvidenceItem;
  results: EvidenceItem[];
  items: EvidenceItem[];
}

type HistoryEntry =
  | { readonly role: 'user' | 'assistant'; readonly text: string }
  | { readonly id: string; readonly call: string; readonly result: string }
  | { readonly kind: string; readonly text: string };

interface PruneState {
  context: string;
  trigger: string;
  focus?: string;
  goal: string[];
  previous_checkpoint?: string;
  history: HistoryEntry[];
  current_turn: HistoryEntry[];
}

export async function pruneEvidence(
  evidence: EvidenceBundle,
  span: PreparedSpan,
  classifier: Classifier,
  context: EvidencePruneContext,
): Promise<{ evidence: EvidenceBundle; report: EvidencePruneReport; debug: EvidencePruneDebug }> {
  const protectedSources = new Set(
    span.sources.filter((source) => source.section === 'turn_prefix').map((source) => source.sourceId),
  );
  const inFlight = protectedSources.size > 0;
  const groups = collectGroups(evidence.items, protectedSources);
  const bulky = [...groups]
    .filter((group) => resultBytes(group) >= JEV_PRUNE_TINY_BYTES)
    .sort((left, right) => resultBytes(right) - resultBytes(left));
  if (bulky.length === 0) {
    const report: EvidencePruneReport = { status: 'skipped', reason: 'no-candidates' };
    return {
      evidence,
      report,
      debug: debugEvent(context.trigger, inFlight, groups, bulky, [], report),
    };
  }
  const actions = new Map<string, EvidencePruneAction>();
  const decisions: EvidencePruneDecision[] = [];
  for (const group of groups) {
    actions.set(group.key, 'keep');
  }

  const state = buildState(evidence.items, protectedSources, groups, context);
  const asked = bulky;
  const askedKeys = new Set(asked.map((group) => group.key));
  let questions: Record<string, CompactionClassifierQuestion> | undefined;
  let answers: unknown;
  let classifierMetadata: ClassifierEvaluationMetadata | undefined;
  if (asked.length > 0) {
    questions = Object.fromEntries(asked.map((group) => [group.id, questionFor(group.id)]));
    try {
      const evaluation = await classifier.evaluate(state, questions, context.signal);
      answers = evaluation.answers;
      classifierMetadata = evaluation.metadata;
      for (const group of asked) {
        const decision = decide(group, evaluation.answers[group.id]);
        actions.set(group.key, decision.action);
        decisions.push(decision);
      }
    } catch (error) {
      if (context.signal?.aborted) throw error;
      const report: EvidencePruneReport = { status: 'skipped', reason: 'classifier-failed' };
      return {
        evidence,
        report,
        debug: debugEvent(context.trigger, inFlight, groups, bulky, asked, report, {
          state,
          questions,
          error: errorMessage(error),
        }),
      };
    }
  }

  const droppedIds = new Set<string>();
  const shortened = new Map<string, string>();
  let kept = 0;
  let shortenedCount = 0;
  let dropped = 0;
  for (const group of groups) {
    const action = actions.get(group.key) ?? 'keep';
    if (action === 'drop') {
      dropped += 1;
      for (const item of group.items) droppedIds.add(item.id);
      continue;
    }
    if (action === 'shorten') {
      shortenedCount += 1;
      for (const item of group.results) shortened.set(item.id, shorten(item.text));
      continue;
    }
    kept += 1;
  }

  const items = evidence.items.flatMap((item) => {
    if (droppedIds.has(item.id)) return [];
    const text = shortened.get(item.id);
    return text === undefined ? [item] : [{ ...item, text }];
  });
  const report: EvidencePruneReport = {
    status: 'ran',
    kept,
    shortened: shortenedCount,
    dropped,
    asked: decisions.length,
    decisions,
    ...(classifierMetadata === undefined ? {} : { classifier: classifierMetadata }),
  };
  return {
    evidence: { ...evidence, items },
    report,
    debug: debugEvent(context.trigger, inFlight, groups, bulky, asked, report, {
      state,
      askedKeys,
      ...(questions === undefined ? {} : { questions }),
      ...(answers === undefined ? {} : { answers }),
    }),
  };
}

const MAX_DEBUG_LEFTOVERS = 128;

function debugEvent(
  trigger: EvidencePruneTrigger,
  inFlight: boolean,
  groups: readonly CandidateGroup[],
  bulky: readonly CandidateGroup[],
  asked: readonly CandidateGroup[],
  report: EvidencePruneReport,
  extras: {
    state?: unknown;
    questions?: Record<string, CompactionClassifierQuestion>;
    answers?: unknown;
    askedKeys?: ReadonlySet<string>;
    error?: string;
  } = {},
): EvidencePruneDebug {
  const askedKeys = extras.askedKeys ?? new Set(asked.map((group) => group.key));
  const leftovers = groups.flatMap((group) => {
    const bytes = resultBytes(group);
    const tiny = bytes < JEV_PRUNE_TINY_BYTES;
    if (!tiny && askedKeys.has(group.key)) return [];
    const toolName = group.call?.toolName ?? group.results[0]?.toolName;
    return [{
      id: group.id || group.key,
      bytes,
      action: 'keep' as EvidencePruneAction,
      reason: (tiny ? 'tiny' : 'unasked') as EvidencePruneLeftoverReason,
      ...(toolName === undefined ? {} : { toolName }),
    }];
  });
  const questions = extras.questions === undefined
    ? undefined
    : Object.fromEntries(
      Object.entries(extras.questions).map(([id, question]) => [id, { instructions: question.instructions }]),
    );
  return {
    trigger,
    inFlight,
    candidates: groups.length,
    bulky: bulky.length,
    tiny: groups.length - bulky.length,
    leftover: leftovers.length,
    leftovers: leftovers.slice(0, MAX_DEBUG_LEFTOVERS),
    report,
    ...(extras.state === undefined ? {} : { state: extras.state, criteria: COMPACTION_CHOICE_CRITERIA }),
    ...(questions === undefined ? {} : { questions }),
    ...(extras.answers === undefined ? {} : { answers: extras.answers }),
    ...(extras.error === undefined ? {} : { error: extras.error }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectGroups(items: readonly EvidenceItem[], protectedSources: ReadonlySet<string>): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  const group = (key: string): CandidateGroup => {
    const existing = groups.get(key);
    if (existing) return existing;
    const created: CandidateGroup = { key, id: '', results: [], items: [] };
    groups.set(key, created);
    return created;
  };
  for (const item of items) {
    if (protectedSources.has(item.sourceId)) continue;
    if (item.status === 'failed' || item.status === 'partial') continue;
    if (item.kind === 'tool-call') {
      const target = group(item.toolCallId ?? item.id);
      target.call = item;
      target.items.push(item);
      continue;
    }
    if (!RESULT_KINDS.has(item.kind)) continue;
    const target = group(item.toolCallId ?? item.id);
    target.results.push(item);
    target.items.push(item);
  }
  return [...groups.values()].filter((entry) => entry.results.length > 0);
}

function buildState(
  items: readonly EvidenceItem[],
  protectedSources: ReadonlySet<string>,
  groups: readonly CandidateGroup[],
  context: EvidencePruneContext,
): PruneState {
  const byItem = new Map<string, CandidateGroup>();
  for (const group of groups) {
    for (const item of group.items) byItem.set(item.id, group);
  }
  const emitted = new Set<string>();
  let nextId = 1;
  const history: HistoryEntry[] = [];
  const currentTurn: HistoryEntry[] = [];
  for (const item of items) {
    const prefix = protectedSources.has(item.sourceId);
    const dest = prefix ? currentTurn : history;
    const grouped = prefix ? undefined : byItem.get(item.id);
    if (grouped) {
      if (emitted.has(grouped.key)) continue;
      emitted.add(grouped.key);
      grouped.id = `e${nextId}`;
      nextId += 1;
      dest.push({
        id: grouped.id,
        call: grouped.call?.text ?? grouped.results[0]?.toolName ?? grouped.key,
        result: resultNote(grouped),
      });
      continue;
    }
    dest.push(historyEntry(item));
  }

  const requests = items
    .filter((item) => item.kind === 'request' && !protectedSources.has(item.sourceId))
    .map((item) => clip(item.text, 500))
    .filter(Boolean)
    .slice(-3);
  const focus = context.customInstructions === undefined ? undefined : clip(context.customInstructions, 1_024);
  const previous = context.previousSummary === undefined ? undefined : clip(context.previousSummary, 2_048);
  const state: PruneState = {
    context: STATE_CONTEXT,
    trigger: triggerSentence(context.trigger, currentTurn.length > 0, Boolean(focus)),
    goal: requests,
    history,
    current_turn: currentTurn,
    ...(focus ? { focus } : {}),
    ...(previous ? { previous_checkpoint: previous } : {}),
  };
  fitState(state);
  return state;
}

function historyEntry(item: EvidenceItem): HistoryEntry {
  if (item.kind === 'request') return { role: 'user', text: clip(item.text, 500) };
  if (item.kind === 'report') return { role: 'assistant', text: clip(item.text, 400) };
  return { kind: item.kind, text: clip(item.text, 400) };
}

function resultNote(group: CandidateGroup): string {
  const result = group.results[0];
  const chars = group.results.reduce((sum, item) => sum + item.text.length, 0);
  const kind = result?.kind ?? 'observation';
  const head = clip(result?.text ?? '', JEV_PRUNE_RESULT_HEAD_CHARS);
  return `${kind}, ${chars} chars: ${head}`;
}

function resultBytes(group: CandidateGroup): number {
  return group.results.reduce((sum, item) => sum + utf8Bytes(item.text), 0);
}

function questionFor(id: string): CompactionClassifierQuestion {
  return {
    type: 'choice',
    instructions: `History item ${id}: what does the continuing agent need from it, given the trigger and goal?`,
    criteria: COMPACTION_CHOICE_CRITERIA,
  };
}

function fitState(state: PruneState): void {
  const shrinkEntry = (entry: HistoryEntry, limit: number): boolean => {
    if ('call' in entry) {
      if (entry.result.length <= limit && entry.call.length <= limit) return false;
      (entry as { call: string; result: string }).call = clip(entry.call, Math.min(limit, 120));
      (entry as { call: string; result: string }).result = clip(entry.result, limit);
      return true;
    }
    if (entry.text.length <= limit) return false;
    (entry as { text: string }).text = clip(entry.text, limit);
    return true;
  };
  let limit = 400;
  while (jsonBytes(state) > DEFAULT_EXTRACTION_BOUNDS.maxEvidenceBytes && limit >= 16) {
    let changed = false;
    if (state.previous_checkpoint && state.previous_checkpoint.length > limit) {
      state.previous_checkpoint = clip(state.previous_checkpoint, limit);
      changed = true;
    }
    if (state.focus && state.focus.length > limit) {
      state.focus = clip(state.focus, limit);
      changed = true;
    }
    state.goal = state.goal.map((item) => clip(item, limit));
    for (const entry of state.history) changed = shrinkEntry(entry, limit) || changed;
    for (const entry of state.current_turn) changed = shrinkEntry(entry, limit) || changed;
    if (!changed) {
      const index = state.history.findIndex((entry) => !('id' in entry));
      if (index >= 0) {
        state.history.splice(index, 1);
        continue;
      }
      break;
    }
    limit = Math.max(40, Math.floor(limit / 2));
  }
}

function decide(group: CandidateGroup, answer: ClassifierAnswer | undefined): EvidencePruneDecision {
  const toolName = group.call?.toolName ?? group.results[0]?.toolName;
  const neverDrop = group.results.some((item) => NEVER_DROP_KINDS.has(item.kind));
  const base = {
    id: group.id,
    ...(toolName === undefined ? {} : { toolName }),
  };
  if (answer?.type !== 'choice' || !isChoice(answer.choice)) {
    return { ...base, action: 'keep', reason: 'missing' };
  }
  const probabilities = boundedProbabilities(answer.probabilities);
  const confidence = unit(answer.confidence);
  const exact = probabilities.exact_contents;
  const actionFromObsolete = neverDrop ? 'shorten' as const : 'drop' as const;
  const action: EvidencePruneAction = exact !== undefined && exact >= JEV_PRUNE_EXACT_KEEP
    ? 'keep'
    : answer.choice === 'exact_contents'
      ? 'keep'
      : answer.choice === 'obsolete' && confidence !== undefined && confidence >= JEV_PRUNE_OBSOLETE_CONFIDENCE
        ? actionFromObsolete
        : 'shorten';
  return {
    ...base,
    action,
    reason: answer.choice,
    choice: answer.choice,
    ...(confidence === undefined ? {} : { confidence }),
    ...(Object.keys(probabilities).length > 0 ? { probabilities } : {}),
  };
}

function isChoice(value: string): value is CompactionClassifierChoice {
  return value === 'exact_contents' || value === 'outcome_only' || value === 'obsolete';
}

function boundedProbabilities(
  value: CompactionClassifierChoiceAnswer['probabilities'],
): Partial<Record<CompactionClassifierChoice, number>> {
  const probabilities: Partial<Record<CompactionClassifierChoice, number>> = {};
  if (!value) return probabilities;
  for (const key of ['exact_contents', 'outcome_only', 'obsolete'] as const) {
    const amount = unit(value[key]);
    if (amount !== undefined) probabilities[key] = amount;
  }
  return probabilities;
}

function unit(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) || value < 0 || value > 1 ? undefined : value;
}

function triggerSentence(trigger: EvidencePruneTrigger, inFlight: boolean, hasFocus: boolean): string {
  if (inFlight && trigger !== 'manual') {
    return 'Mid-turn overflow: the agent resumes the unfinished task in current_turn immediately. Judge older items by whether finishing that task needs them.';
  }
  if (trigger === 'manual') {
    return hasFocus
      ? 'Manual compaction: the user will continue with follow-up requests about this work, using the stated focus.'
      : 'Manual compaction: the user will continue with follow-up requests about this work.';
  }
  return 'End-of-turn: the agent finished; the user will continue with follow-up requests about this work. Outcomes matter; consumed observations mostly do not.';
}

function shorten(text: string): string {
  if (text.length <= JEV_PRUNE_HEAD_CHARS) return text;
  return `${text.slice(0, JEV_PRUNE_HEAD_CHARS)}\n[jev: shortened ${text.length - JEV_PRUNE_HEAD_CHARS} characters]`;
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1))}…`;
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}
