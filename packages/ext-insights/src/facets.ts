import type { AiInsights, AiSessionFacet, InsightRecommendation, ParsedSession } from './types.js';

const MAX_FACET_SESSIONS = 12;
const MAX_TRANSCRIPT_CHARS = 5_000;

export interface FacetModelClient { complete(prompt: string): Promise<string>; }
export interface BuildAiInsightsOptions {
  readonly sessions: readonly ParsedSession[];
  readonly transcriptById: ReadonlyMap<string, string>;
  readonly modelClient?: FacetModelClient;
}

export async function buildAiInsights(options: BuildAiInsightsOptions): Promise<AiInsights> {
  if (!options.modelClient) return unavailable('No active model client available for AI facet extraction.');
  const recent = [...options.sessions].sort((a, b) => b.startTime.getTime() - a.startTime.getTime()).slice(0, MAX_FACET_SESSIONS);
  const facets: AiSessionFacet[] = [];
  const recommendations: InsightRecommendation[] = [];
  const stopDoing: InsightRecommendation[] = [];
  let failures = 0;
  for (const session of recent) {
    const transcript = options.transcriptById.get(session.id);
    if (!transcript) continue;
    try {
      const value = normalizeFacetResponse(session.id, parseJsonObject(await options.modelClient.complete(buildPrompt(session, transcript))));
      facets.push(value.facet); recommendations.push(...value.recommendations); stopDoing.push(...value.stopDoing);
    } catch { failures += 1; }
  }
  if (!facets.length) return unavailable(failures ? 'AI facet extraction failed for the selected sessions.' : 'No session files were available for AI facet extraction.');
  return { status: failures ? 'partial' : 'available', generatedAt: new Date().toISOString(), cacheState: 'miss', facets, recommendations: dedupe(recommendations), stopDoing: dedupe(stopDoing) };
}

interface FacetResponse { facet: AiSessionFacet; recommendations: InsightRecommendation[]; stopDoing: InsightRecommendation[]; }
export function normalizeFacetResponse(sessionId: string, value: unknown): FacetResponse {
  if (!value || typeof value !== 'object') throw new Error('Facet response must be a JSON object.');
  const data = value as Record<string, unknown>;
  const facet: AiSessionFacet = { sessionId, goal: stringValue(data.goal), goalCategories: strings(data.goalCategories ?? data.goal_categories), outcome: stringValue(data.outcome), satisfaction: satisfaction(data.satisfaction), friction: strings(data.friction), helpfulness: stringValue(data.helpfulness), sessionType: stringValue(data.sessionType ?? data.session_type), summary: stringValue(data.summary) };
  if (!facet.goal && !facet.outcome && !facet.summary) throw new Error('Facet response must include at least one of goal, outcome, or summary.');
  return { facet, recommendations: recommendations(data.recommendations, 'try'), stopDoing: recommendations(data.stopDoing ?? data.stop_doing, 'stop') };
}
export function parseJsonObject(text: string): unknown { try { return JSON.parse(text); } catch { const start = text.indexOf('{'); const end = text.lastIndexOf('}'); if (start < 0 || end <= start) throw new Error('Model did not return a JSON object.'); return JSON.parse(text.slice(start, end + 1)); } }
function buildPrompt(session: ParsedSession, transcript: string): string { return `Analyze this coding session. Return JSON with optional goal, outcome, satisfaction, friction, helpfulness, sessionType, summary, recommendations, and stopDoing. Session: ${session.projectName}, ${session.messageCount} messages, ${session.toolCallCount} tool calls.\nTranscript:\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`; }
function unavailable(reason: string): AiInsights { return { status: 'unavailable', cacheState: 'skipped', unavailableReason: reason, facets: [], recommendations: [], stopDoing: [] }; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function strings(value: unknown): string[] | undefined { if (!Array.isArray(value)) return undefined; const result = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()); return result.length ? result : undefined; }
function satisfaction(value: unknown): AiSessionFacet['satisfaction'] | undefined { return value === 'positive' || value === 'neutral' || value === 'negative' || value === 'mixed' ? value : undefined; }
function recommendations(value: unknown, fallback: InsightRecommendation['category']): InsightRecommendation[] { if (!Array.isArray(value)) return []; return value.flatMap((item) => { if (!item || typeof item !== 'object') return []; const data = item as Record<string, unknown>; const title = stringValue(data.title); const detail = stringValue(data.detail); return title && detail ? [{ title, detail, prompt: stringValue(data.prompt), category: category(data.category) ?? fallback }] : []; }); }
function category(value: unknown): InsightRecommendation['category'] | undefined { return value === 'try' || value === 'stop' || value === 'workflow' || value === 'model' ? value : undefined; }
function dedupe(items: InsightRecommendation[]): InsightRecommendation[] { const seen = new Set<string>(); return items.filter((item) => { const key = `${item.category ?? ''}:${item.title}:${item.detail}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
