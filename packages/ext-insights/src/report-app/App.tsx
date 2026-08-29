import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FELAN_LOGO } from './logo.js';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area, Legend, LineChart, Line
} from 'recharts';
import { computeAnalytics } from '../analytics.js';
import type { ParsedSession as ComputedSession } from '../types.js';
import type { Analytics, InsightsSavingsBucket, InsightsSavingsReport } from '../types.js';
import { formatNumber, formatInteger, formatDuration, formatCost, formatPercent, COLORS } from './utils.js';
import type { RageStats } from '../types.js';
import ContributionCalendar from './components/ContributionCalendar.js';
import './styles.css';

const allData: Analytics = window.__FELAN_INSIGHTS_DATA__;
const chartGrid = 'hsl(var(--color-border))';
const chartText = 'hsl(var(--color-text-muted))';
const chartPrimary = 'hsl(var(--chart-1))';
const chartDanger = 'hsl(var(--color-danger))';

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="chart-tooltip-row">
          <span className="chart-tooltip-swatch" style={{ background: p.color || COLORS[i % COLORS.length] }} />
          <span className="chart-tooltip-label">{p.name}:</span>
          <span className="chart-tooltip-value">
            {typeof p.value === 'number' ? formatNumber(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

// Format date in local timezone
function localDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

function localDateTime(isoStr: string): string {
  const d = new Date(isoStr);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return date + '\n' + time;
}

function localTimeLabel(hour: number): string {
  return String(hour).padStart(2, '0') + ':00';
}

type DateRange = { start: string; end: string };

function todayDate(): string {
  return new Date().toISOString().split('T')[0];
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
}

function recentDateRange(analytics: Analytics, days: number): DateRange {
  const end = analytics.dateRange.end || todayDate();
  return { start: addDays(end, 1 - days), end };
}

function allTimeDateRange(analytics: Analytics): DateRange {
  if (!analytics.dateRange.start || !analytics.dateRange.end) return { start: '', end: '' };
  return { start: analytics.dateRange.start, end: analytics.dateRange.end };
}

function formatDateRange(range: DateRange): string {
  const start = range.start ? localDate(range.start) : 'Beginning';
  const end = range.end ? localDate(range.end) : 'Today';
  return start + ' – ' + end;
}

function toComputedSession(session: Analytics['sessions'][number]): ComputedSession {
  return {
    ...session,
    startTime: new Date(session.startTime),
    endTime: new Date(session.endTime),
    rageHits: session.rageHits ?? [],
  };
}

function filterAnalyticsByDate(analytics: Analytics, range: DateRange): Analytics {
  const sessions = analytics.sessions
    .filter(session => {
      const date = session.startTime.split('T')[0];
      return (!range.start || date >= range.start) && (!range.end || date <= range.end);
    })
    .map(toComputedSession);

  const filtered = computeAnalytics(sessions) as unknown as Analytics;
  filtered.ai = analytics.ai;
  filtered.cache = analytics.cache;
  filtered.export = analytics.export;
  if (analytics.savings) {
    filtered.savings = filterSavingsByDate(analytics.savings, range);
  }
  return filtered;
}

function filterSavingsByDate(report: InsightsSavingsReport, range: DateRange): InsightsSavingsReport {
  const buckets = report.buckets.filter((bucket) =>
    (!range.start || bucket.day >= range.start) && (!range.end || bucket.day <= range.end));
  return summarizeSavings(report, buckets);
}

function summarizeSavings(report: InsightsSavingsReport, buckets: InsightsSavingsBucket[]): InsightsSavingsReport {
  const baselineCostUsd = buckets.reduce((sum, bucket) => sum + (bucket.baselineCostUsd ?? 0), 0);
  const actualCostUsd = buckets.reduce((sum, bucket) => sum + (bucket.actualCostUsd ?? 0), 0);
  return {
    ...report,
    calls: buckets.reduce((sum, bucket) => sum + bucket.calls, 0),
    baselineCostUsd,
    actualCostUsd,
    savedCostUsd: baselineCostUsd - actualCostUsd,
    hasUnpricedMeasurements: report.hasUnpricedMeasurements || buckets.some((bucket) => bucket.priceSource.includes('unavailable')),
    buckets,
  };
}

// ── Stat Card ───────────────────────────────────────────────────────

function StatCard({ value, label, sublabel }: { value: string; label: string; sublabel?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sublabel && <div className="stat-sublabel">{sublabel}</div>}
    </div>
  );
}

// ── Model Bar ───────────────────────────────────────────────────────

const ModelBar = ({ name, value, max, color, formatValue = formatNumber }: { name: string; value: number; max: number; color: string; formatValue?: (value: number) => string }) => (
  <div className="model-bar">
    <div className="model-bar-label" title={name}>{name}</div>
    <div className="model-bar-track">
      <div className="model-bar-fill" style={{
        width: max ? (value / max * 100) + '%' : '0%',
        background: color
      }} />
    </div>
    <div className="model-bar-value">{formatValue(value)}</div>
  </div>
);

// ── Daily Chart Section (tabbed: Sessions / Tokens / Cost) ──────────

function DailyChartSection({ data }: { data: Array<{ date: string; Sessions: number; Messages: number; Tokens: number; Cost: number }> }) {
  const [metric, setMetric] = useState<'Sessions' | 'Tokens' | 'Cost'>('Sessions');

  return (
    <div className="section">
      <div className="chart-card chart-full" style={{ padding: 0 }}>
        {/* Inline tabs */}
        <div className="daily-chart-tabs">
          {(['Sessions', 'Tokens', 'Cost'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`daily-chart-tab${metric === m ? ' active' : ''}`}
            >
              {m} per Day
            </button>
          ))}
        </div>

        <div style={{ padding: '16px 20px 20px' }}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: chartText, fontSize: 11 }}
                axisLine={{ stroke: chartGrid }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: chartText, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(value: number) => metric === 'Cost' ? formatCost(value) : formatNumber(value)}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const val = payload[0].value as number;
                  const display = metric === 'Cost'
                    ? formatCost(val)
                    : formatNumber(val);
                  return (
                    <div className="chart-tooltip compact">
                      <div className="chart-tooltip-title">{label}</div>
                      <div>{metric}: <span style={{ fontWeight: 500 }}>{display}</span></div>
                    </div>
                  );
                }}
              />
              <Bar dataKey={metric} radius={[3, 3, 0, 0]}>
                {data.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ── Rage Tab ────────────────────────────────────────────────────────────

function RageTab({ rage, totalUserMessages }: { rage: RageStats; totalUserMessages: number }) {
  const hourLabels = (h: number) => String(h).padStart(2, '0') + ':00';

  const filthiestModel = rage.byModel[0]?.name ?? '—';
  const peakHour = rage.byHour.reduce(
    (best, h) => h.count > best.count ? h : best,
    { hour: 0, count: 0 }
  );
  const swearRate = totalUserMessages > 0
    ? rage.messagesWithSwears / totalUserMessages
    : 0;

  const maxProjectCount = Math.max(...rage.byProject.map(p => p.count), 1);

  if (rage.total === 0) {
    return (
      <div className="section">
        <div className="chart-card empty-state">
          <div className="empty-title">Squeaky clean</div>
          <div className="empty-detail">No profanity detected in your sessions.</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Stat row */}
      <div className="stats-grid">
        <StatCard value={formatInteger(rage.total)} label="Total Swears" />
        <StatCard value={formatPercent(swearRate)} label="Swear Rate" sublabel="of user messages" />
        <StatCard
          value={filthiestModel.length > 20 ? filthiestModel.slice(0, 20) + '…' : filthiestModel}
          label="Filthiest Model"
        />
        <StatCard
          value={hourLabels(peakHour.hour)}
          label="Peak Hour"
          sublabel={`${formatInteger(peakHour.count)} swears`}
        />
        <StatCard
          value={rage.topWords[0]?.word ?? '—'}
          label="Top Word"
          sublabel={rage.topWords[0] ? `${formatInteger(rage.topWords[0].count)}×` : undefined}
        />
        <StatCard
          value={formatInteger(rage.byProject.length)}
          label="Projects Affected"
          sublabel={rage.byProject[0]?.name}
        />
      </div>

      {/* By model */}
      <div className="section">
        <div className="section-header"><h2 className="section-title">By Model</h2></div>
        <div className="section-subtitle">Swear count while each model was active</div>
        <div className="chart-card chart-full">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={rage.byModel} margin={{ top: 10, right: 10, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fill: chartText, fontSize: 10 }}
                axisLine={{ stroke: chartGrid }}
                tickLine={false}
                angle={-30}
                textAnchor="end"
                interval={0}
              />
              <YAxis tick={{ fill: chartText, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={formatNumber} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div className="chart-tooltip compact">
                      <div className="chart-tooltip-title">{label}</div>
                      <div>Swears: <span style={{ fontWeight: 500 }}>{formatInteger(Number(payload[0].value))}</span></div>
                    </div>
                  );
                }}
              />
              <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                {rage.byModel.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* By hour */}
      <div className="section">
        <div className="section-header"><h2 className="section-title">By Hour</h2></div>
        <div className="section-subtitle">When you swear throughout the day (local time)</div>
        <div className="chart-card chart-full">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={rage.byHour} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="rageHourGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartDanger} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={chartDanger} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} vertical={false} />
              <XAxis
                dataKey="hour"
                tickFormatter={hourLabels}
                tick={{ fill: chartText, fontSize: 11 }}
                axisLine={{ stroke: chartGrid }}
                tickLine={false}
                interval={2}
              />
              <YAxis tick={{ fill: chartText, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={formatNumber} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div className="chart-tooltip compact">
                      <div className="chart-tooltip-title">{hourLabels(label as number)}</div>
                      <div>Swears: <span style={{ fontWeight: 500 }}>{formatInteger(Number(payload[0].value))}</span></div>
                    </div>
                  );
                }}
              />
              <Area type="monotone" dataKey="count" stroke={chartDanger} fill="url(#rageHourGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top words + by project */}
      <div className="chart-row">
        <div className="section" style={{ flex: 1 }}>
          <div className="section-header"><h2 className="section-title">Top Words</h2></div>
          <div className="section-subtitle">Your favourite expressions</div>
          <div className="chart-card">
            {rage.topWords.map((w, i) => (
              <ModelBar
                key={w.word}
                name={w.word}
                value={w.count}
                max={rage.topWords[0]?.count ?? 1}
                color={COLORS[i % COLORS.length]}
              />
            ))}
          </div>
        </div>

        <div className="section" style={{ flex: 1 }}>
          <div className="section-header"><h2 className="section-title">By Project</h2></div>
          <div className="section-subtitle">Which project makes you angriest</div>
          <div className="chart-card">
            {rage.byProject.map((p, i) => (
              <ModelBar
                key={p.name}
                name={p.name}
                value={p.count}
                max={maxProjectCount}
                color={COLORS[i % COLORS.length]}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function DeltaValue({ value, format = 'number' }: { value: number; format?: 'number' | 'cost' }) {
  const positive = value > 0;
  const display = format === 'cost' ? formatCost(Math.abs(value)) : formatNumber(Math.abs(value));
  return <span className={positive ? 'delta negative' : value < 0 ? 'delta positive' : 'delta'}>{positive ? '+' : value < 0 ? '−' : ''}{display}</span>;
}

function TrendsTab({ data }: { data: Analytics }) {
  const temporal = data.temporal;

  if (!temporal) {
    return <EmptyState title="No trend data" detail="Temporal analytics were not generated for this report." />;
  }

  return (
    <>
      <div className="stats-grid">
        <StatCard value={temporal.trajectory?.cost ?? 'stable'} label="Cost Trajectory" sublabel="week over week" />
        <StatCard value={temporal.trajectory?.errors ?? 'stable'} label="Error Trajectory" sublabel="week over week" />
        <StatCard value={formatNumber(Math.round(temporal.decayWeightedActivity?.sessions ?? 0))} label="Weighted Sessions" sublabel={`${formatNumber(temporal.decayHalfLifeDays ?? 10)}d half-life`} />
        <StatCard value={formatCost(temporal.decayWeightedActivity?.cost ?? 0)} label="Weighted Cost" sublabel="recent sessions count more" />
      </div>

      <div className="section">
        <div className="section-header"><h2 className="section-title">What Changed This Week</h2></div>
        <div className="section-subtitle">Current 7-day window compared with the previous 7 days</div>
        <div className="chart-card insight-grid">
          <InsightMetric label="Sessions" value={<DeltaValue value={temporal.weekOverWeek?.sessionsDelta ?? 0} />} />
          <InsightMetric label="Cost" value={<DeltaValue value={temporal.weekOverWeek?.costDelta ?? 0} format="cost" />} />
          <InsightMetric label="Tool errors" value={<DeltaValue value={temporal.weekOverWeek?.toolErrorDelta ?? 0} />} />
        </div>
      </div>

      <div className="chart-row">
        <div className="section">
          <div className="section-header"><h2 className="section-title">Anomalies</h2></div>
          <div className="section-subtitle">Cost and error spikes detected deterministically</div>
          <div className="chart-card">
            {temporal.anomalies?.length ? temporal.anomalies.map((item, index) => <InsightItem key={index} item={item} />) : <MutedText>No anomalies detected.</MutedText>}
          </div>
        </div>

        <div className="section">
          <div className="section-header"><h2 className="section-title">Friction Signals</h2></div>
          <div className="section-subtitle">Resolved vs ongoing deterministic friction</div>
          <div className="chart-card">
            <h3 className="mini-heading">Ongoing</h3>
            {temporal.deterministicFriction?.ongoing.length ? temporal.deterministicFriction.ongoing.map((item, index) => <InsightItem key={index} item={item} />) : <MutedText>No ongoing deterministic friction.</MutedText>}
            <h3 className="mini-heading" style={{ marginTop: 16 }}>Resolved</h3>
            {temporal.deterministicFriction?.resolved.length ? temporal.deterministicFriction.resolved.map((item, index) => <InsightItem key={index} item={item} />) : <MutedText>No recently resolved friction signals.</MutedText>}
          </div>
        </div>
      </div>
    </>
  );
}

function ModelEfficiencyTab({ data }: { data: Analytics }) {
  const summary = data.modelEfficiency;
  const maxCost = Math.max(...(summary?.models.map(model => model.cost) ?? []), 1);

  if (!summary || summary.models.length === 0) {
    return <EmptyState title="No model-efficiency data" detail="No token-generating model usage was found for this date range." />;
  }

  return (
    <>
      <div className="section">
        <div className="section-header"><h2 className="section-title">Model Efficiency</h2></div>
        <div className="section-subtitle">Cost, throughput, duration, and tool-error signals by model</div>
        <div className="chart-card">
          {summary.models.map((model, index) => (
            <div key={model.model} className="efficiency-row">
              <ModelBar name={model.model} value={model.cost} max={maxCost} color={COLORS[index % COLORS.length]} formatValue={formatCost} />
              <div className="efficiency-metrics">
                <span>{formatNumber(model.tokens)} tokens</span>
                <span>{formatCost(model.cost)} total</span>
                <span>{formatCost(model.costPerToken)} / token</span>
                <span>{formatCost(model.costPerMessage)} / msg</span>
                <span>{formatDuration(model.avgSessionDuration)} avg</span>
                <span>{formatPercent(model.toolErrorRate ?? 0)} error-rate</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-header"><h2 className="section-title">Efficiency Recommendations</h2></div>
        <div className="chart-card">
          {summary.recommendations.length ? summary.recommendations.map((rec, index) => <InsightItem key={index} item={{ severity: 'info', title: 'Recommendation', detail: rec }} />) : <MutedText>No model-efficiency recommendations generated.</MutedText>}
        </div>
      </div>
    </>
  );
}

function RecommendationsTab({ data }: { data: Analytics }) {
  const ai = data.ai;
  const analysis = data.analysis;
  const availableAi = ai && ai.status !== 'unavailable' ? ai : undefined;

  return (
    <>
      <div className="section">
        <div className="section-header"><h2 className="section-title">Deterministic Analysis</h2></div>
        <div className="section-subtitle">Generated locally from session metadata, trends, friction, and model-efficiency signals</div>
        <div className="chart-card">
          {analysis?.takeaways.length ? analysis.takeaways.map((item, index) => <InsightItem key={index} item={item} />) : <MutedText>No deterministic takeaways generated for this date range.</MutedText>}
        </div>
      </div>

      <div className="chart-row">
        <RecommendationSection title="Recommended Next Steps" empty="No deterministic recommendations generated." items={analysis?.recommendations ?? []} />
        <RecommendationSection title="Consider Stopping" empty="No deterministic stop-doing suggestions generated." items={analysis?.stopDoing ?? []} />
      </div>

      <div className="section">
        <div className="section-header"><h2 className="section-title">AI Facet Source</h2></div>
        <div className="chart-card insight-grid">
          <InsightMetric label="Status" value={ai?.status ?? 'unavailable'} />
          <InsightMetric label="Cache" value={ai?.cacheState ?? 'skipped'} />
          <InsightMetric label="Range" value={ai?.sourceRange ? `${localDate(ai.sourceRange.start)} – ${localDate(ai.sourceRange.end)}` : 'not generated'} />
        </div>
        <div className="section-subtitle" style={{ marginTop: 10 }}>{availableAi ? 'AI facets are generated at report time and are not recomputed by browser-side date filtering.' : (ai?.unavailableReason ?? 'AI facets were not generated; deterministic analysis above remains available.')}</div>
      </div>

      {availableAi && (
        <>
          <div className="chart-row">
            <RecommendationSection title="AI Next Steps" empty="No AI recommendations generated." items={availableAi.recommendations} />
            <RecommendationSection title="AI Stop-Doing Suggestions" empty="No AI stop-doing suggestions generated." items={availableAi.stopDoing} />
          </div>

          <div className="section">
            <div className="section-header"><h2 className="section-title">Session Facets</h2></div>
            <div className="chart-card facets-grid">
              {availableAi.facets.length ? availableAi.facets.map(facet => (
                <div className="facet-card" key={facet.sessionId}>
                  <div className="facet-title">{facet.goal ?? facet.summary ?? facet.sessionId}</div>
                  <div className="facet-meta">{facet.sessionType ?? 'session'} · {facet.satisfaction ?? 'unknown satisfaction'}</div>
                  {facet.outcome && <p>{facet.outcome}</p>}
                  {facet.friction?.length ? <div className="facet-tags">{facet.friction.map(item => <span className="tag" key={item}>{item}</span>)}</div> : null}
                </div>
              )) : <MutedText>No AI session facets generated.</MutedText>}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function RecommendationSection({ title, empty, items }: { title: string; empty: string; items: NonNullable<Analytics['ai']>['recommendations'] }) {
  return (
    <div className="section">
      <div className="section-header"><h2 className="section-title">{title}</h2></div>
      <div className="chart-card">
        {items.length ? items.map((item, index) => (
          <div className="recommendation" key={`${item.title}-${index}`}>
            <div className="recommendation-title">{item.title}</div>
            <div className="recommendation-detail">{item.detail}</div>
            {item.prompt && <code>{item.prompt}</code>}
          </div>
        )) : <MutedText>{empty}</MutedText>}
      </div>
    </div>
  );
}

function InsightMetric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="insight-metric">
      <div className="insight-metric-label">{label}</div>
      <div className="insight-metric-value">{value}</div>
    </div>
  );
}

function InsightItem({ item }: { item: { severity: string; title: string; detail: string } }) {
  return (
    <div className={`insight-item ${item.severity}`}>
      <div className="insight-item-title">{item.title}</div>
      <div className="insight-item-detail">{item.detail}</div>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="section">
      <div className="chart-card empty-state">
        <div className="empty-title">{title}</div>
        <div className="empty-detail">{detail}</div>
      </div>
    </div>
  );
}

function MutedText({ children }: { children: ReactNode }) {
  return <div className="muted-text">{children}</div>;
}

function SavingsTab({ report }: { report: InsightsSavingsReport | undefined }) {
  const [producer, setProducer] = useState('all');
  const [category, setCategory] = useState('all');
  const [project, setProject] = useState('all');
  const [breakdown, setBreakdown] = useState<'daily' | 'category' | 'producer' | 'project'>('daily');
  if (!report) return <EmptyState title="No Savings data" detail="No persisted optimization measurements were available for this report." />;
  const producers = [...new Set(report.buckets.map((bucket) => bucket.producerId))].sort();
  const categories = [...new Set(report.buckets.map((bucket) => bucket.category))].sort();
  const projects = [...new Set(report.buckets.map((bucket) => bucket.projectName ?? bucket.projectKey))].sort();
  const buckets = report.buckets.filter((bucket) =>
    (producer === 'all' || bucket.producerId === producer) &&
    (category === 'all' || bucket.category === category) &&
    (project === 'all' || (bucket.projectName ?? bucket.projectKey) === project));
  const filtered = summarizeSavings(report, buckets);
  const daily = aggregateSavings(buckets, (bucket) => bucket.day);
  const byCategory = aggregateSavings(buckets, (bucket) => bucket.category);
  const byProducer = aggregateSavings(buckets, (bucket) => bucket.producerId);
  const byProject = aggregateSavings(buckets, (bucket) => bucket.projectName ?? bucket.projectKey);
  const breakdowns = [
    { id: 'daily', label: 'Daily', items: daily },
    { id: 'category', label: 'Category', items: byCategory },
    { id: 'producer', label: 'Producer', items: byProducer },
    { id: 'project', label: 'Project', items: byProject },
  ] as const;
  return <>
    <div className="section-header"><h2 className="section-title">Savings</h2></div>
    <div className="section-subtitle">Estimated API-equivalent cost avoided by Felan optimizations.</div>
    <div className="savings-filters">
      <FilterSelect label="Producer" value={producer} options={producers} onChange={setProducer} />
      <FilterSelect label="Category" value={category} options={categories} onChange={setCategory} />
      <FilterSelect label="Project" value={project} options={projects} onChange={setProject} />
    </div>
    <div className="stats-grid savings-stats">
      <StatCard value={formatCost(filtered.savedCostUsd)} label="Estimated avoided" />
      <StatCard value={formatCost(filtered.baselineCostUsd)} label="Baseline cost" />
      <StatCard value={formatCost(filtered.actualCostUsd)} label="Actual cost" />
      <StatCard value={formatNumber(filtered.calls)} label="Optimization calls" />
    </div>
    {report.diagnostics.map((diagnostic) => <div className="insight-item warning" key={diagnostic}><div className="insight-item-detail">{diagnostic}</div></div>)}
    <SavingsBreakdown breakdowns={breakdowns} selected={breakdown} onSelect={setBreakdown} />
    <div className="section"><div className="section-header"><h2 className="section-title">Measurement details</h2></div><div className="chart-card" style={{ overflowX: 'auto' }}><table className="session-table"><thead><tr><th>Date</th><th>Project</th><th>Producer</th><th>Category</th><th>Calls</th><th>Baseline</th><th>Actual</th><th>Saved</th><th>Basis</th><th>Models</th></tr></thead><tbody>{buckets.map((bucket, index) => <tr key={`${bucket.day}-${bucket.producerId}-${bucket.category}-${index}`}><td>{bucket.day}</td><td>{bucket.projectName ?? bucket.projectKey.slice(0, 12)}</td><td>{bucket.producerId}</td><td>{bucket.category}</td><td className="num">{formatInteger(bucket.calls)}</td><td className="num">{formatCost(bucket.baselineCostUsd ?? 0)}</td><td className="num">{formatCost(bucket.actualCostUsd ?? 0)}</td><td className="num cost">{formatCost((bucket.baselineCostUsd ?? 0) - (bucket.actualCostUsd ?? 0))}</td><td>{bucket.basis}</td><td>{bucket.baselineModel ?? '—'} → {bucket.actualModel ?? '—'}</td></tr>)}</tbody></table>{buckets.length === 0 && <MutedText>No measurements match these filters.</MutedText>}</div></div>
  </>;
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="savings-filter">{label}<select value={value} onChange={(event) => onChange(event.target.value)}><option value="all">All</option>{options.map((option) => <option value={option} key={option}>{option}</option>)}</select></label>;
}

function aggregateSavings(buckets: InsightsSavingsBucket[], key: (bucket: InsightsSavingsBucket) => string): Array<{ name: string; count: number }> {
  const totals = new Map<string, number>();
  for (const bucket of buckets) totals.set(key(bucket), (totals.get(key(bucket)) ?? 0) + (bucket.baselineCostUsd ?? 0) - (bucket.actualCostUsd ?? 0));
  return [...totals.entries()].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count).slice(0, 12);
}

function SavingsBreakdown({ breakdowns, selected, onSelect }: {
  breakdowns: ReadonlyArray<{ id: 'daily' | 'category' | 'producer' | 'project'; label: string; items: Array<{ name: string; count: number }> }>;
  selected: 'daily' | 'category' | 'producer' | 'project';
  onSelect: (value: 'daily' | 'category' | 'producer' | 'project') => void;
}) {
  const current = breakdowns.find((item) => item.id === selected) ?? breakdowns[0];
  const max = Math.max(...current.items.map((item) => item.count), 0);
  return <div className="section">
    <div className="section-header"><h2 className="section-title">Avoided cost breakdown</h2></div>
    <div className="chart-card savings-breakdown-card">
      <div className="daily-chart-tabs" role="tablist" aria-label="Savings breakdown">
        {breakdowns.map((item) => <button key={item.id} id={`savings-tab-${item.id}`} className={`daily-chart-tab${selected === item.id ? ' active' : ''}`} type="button" role="tab" aria-selected={selected === item.id} aria-controls="savings-breakdown-panel" onClick={() => onSelect(item.id)}>{item.label}</button>)}
      </div>
      <div id="savings-breakdown-panel" className="savings-breakdown-content" role="tabpanel" aria-labelledby={`savings-tab-${current.id}`}>
        {current.items.length ? current.items.map((item, index) => <ModelBar key={item.name} name={item.name} value={item.count} max={max || 1} color={COLORS[index % COLORS.length]} formatValue={formatCost} />) : <MutedText>No savings measurements.</MutedText>}
      </div>
    </div>
  </div>;
}

function SunIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" /></svg>;
}

function MoonIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.4A8 8 0 0 1 9.6 3.5 8.5 8.5 0 1 0 20.5 14.4Z" /></svg>;
}

const navigationItems = [
  ['overview', 'Overview'],
  ['savings', 'Savings'],
  ['trends', 'Trends'],
  ['models', 'Models'],
  ['efficiency', 'Model Efficiency'],
  ['projects', 'Projects'],
  ['sessions', 'Sessions'],
  ['recommendations', 'Recommendations'],
  ['rage', 'Rage'],
] as const;
type NavigationItem = typeof navigationItems[number][0];

// ── Main App ─────────────────────────────────────────────────────────

function App() {
  const [activeTab, setActiveTab] = useState<NavigationItem>('overview');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const [sessionFilter, setSessionFilter] = useState('');
  const [projectSort, setProjectSort] = useState<'messages' | 'sessions' | 'tokens' | 'cost'>('messages');
  const [dateRange, setDateRange] = useState<DateRange>(() => recentDateRange(allData, 30));
  const data = useMemo(() => filterAnalyticsByDate(allData, dateRange), [dateRange]);

  const dailyChartData = useMemo(() =>
    data.dailyStats.map(d => ({
      date: localDate(d.date),
      Sessions: d.sessions,
      Messages: d.messages,
      Tokens: d.tokens,
      Cost: d.cost,
    })), [data.dailyStats]);

  const hourlyChartData = useMemo(() =>
    data.hourlyDistribution.map(h => ({
      hour: localTimeLabel(h.hour),
      rawHour: h.hour,
      Sessions: h.count,
    })), [data.hourlyDistribution]);

  const modelPieData = useMemo(() =>
    data.modelStats.slice(0, 6).map(m => ({
      name: m.name,
      value: m.tokens,
    })), [data.modelStats]);

  const maxModelTokens = useMemo(() =>
    Math.max(...data.modelStats.map(m => m.tokens), 1),
  [data.modelStats]);

  const filteredSessions = useMemo(() => {
    const reversed = [...data.sessions].reverse();
    if (!sessionFilter.trim()) return reversed;
    const q = sessionFilter.toLowerCase();
    return reversed.filter(s =>
      s.projectName.toLowerCase().includes(q) ||
      s.startTime.toLowerCase().includes(q)
    );
  }, [data.sessions, sessionFilter]);

  const sortedProjects = useMemo(() => {
    const projects = [...data.projectStats];
    return projects.sort((a, b) => b[projectSort] - a[projectSort]);
  }, [data.projectStats, projectSort]);

  const dateRangeStr = formatDateRange(dateRange);

  useEffect(() => {
    const key = 'felan-insights-theme';
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem(key, theme); } catch { /* file:// may deny storage */ }
  }, [theme]);

  return (
    <div className="container">
      <header className="header">
        <div className="header-row">
          <div className="brand-lockup">
            <span className="felan-mark" aria-hidden="true"><img src={`data:image/svg+xml,${encodeURIComponent(FELAN_LOGO)}`} alt="" /></span>
            <div>
              <h1>Felan Insights</h1>
              <span className="product-label">Local session analytics</span>
            </div>
          </div>
          <button className="theme-button" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} aria-pressed={theme === 'dark'}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
        <p className="header-subtitle">
          <span>{dateRangeStr}</span>
          <span>{formatInteger(data.totalSessions)} sessions</span>
          <span>{formatInteger(data.projectStats.length)} projects</span>
          <span>{formatInteger(data.modelStats.length)} models</span>
        </p>
      </header>

      <div className="date-filter">
        <div className="date-filter-controls">
          <label>
            Start
            <input
              type="date"
              value={dateRange.start}
              onChange={e => setDateRange(current => ({ ...current, start: e.target.value }))}
            />
          </label>
          <label>
            End
            <input
              type="date"
              value={dateRange.end}
              onChange={e => setDateRange(current => ({ ...current, end: e.target.value }))}
            />
          </label>
          <button onClick={() => setDateRange(recentDateRange(allData, 7))}>Last 7 days</button>
          <button onClick={() => setDateRange(recentDateRange(allData, 30))}>Last 30 days</button>
          <button onClick={() => setDateRange(allTimeDateRange(allData))}>All time</button>
        </div>
        <div className="date-filter-summary">
          Showing {formatInteger(data.totalSessions)} of {formatInteger(allData.totalSessions)} sessions
        </div>
      </div>

      <nav className="tab-bar" aria-label="Insights sections">
        {navigationItems.map(([id, label]) => <button key={id} className={`tab ${activeTab === id ? 'active' : ''}`} aria-current={activeTab === id ? 'page' : undefined} onClick={() => setActiveTab(id)}>{label}</button>)}
      </nav>

      {activeTab === 'overview' && (
        <>
          <div className="stats-grid overview-stats">
            <StatCard value={formatInteger(data.totalSessions)} label="Sessions" sublabel={`${formatNumber(data.avgMessagesPerSession)} msgs avg · ${formatDuration(data.avgSessionDuration)} each`} />
            <StatCard value={formatNumber(data.totalMessages)} label="Messages" />
            <StatCard value={formatDuration(data.totalDuration)} label="Active Time" sublabel={`${formatDuration(data.avgSessionDuration)} avg`} />
            <StatCard value={formatInteger(data.modelStats.length)} label="Models" sublabel={`${formatInteger(data.modelSwitchCount)} multi-model sessions`} />
            <StatCard value={formatNumber(data.totalTokens)} label="Tokens" />
            <StatCard value={formatCost(data.totalCost)} label="Cost" />
          </div>
          <div className="section">
            <div className="section-header">
              <h2 className="section-title">Activity Calendar</h2>
            </div>
            <div className="section-subtitle">Daily session intensity over the past year</div>
            <div className="chart-card chart-full">
              <ContributionCalendar dailyStats={data.dailyStats} />
            </div>
          </div>

          <DailyChartSection data={dailyChartData} />

          <div className="section">
            <div className="section-header">
              <h2 className="section-title">Activity by Hour</h2>
            </div>
            <div className="section-subtitle">Session starts distributed across hours</div>
            <div className="chart-card chart-full">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={hourlyChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="hourlyGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={chartPrimary} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={chartPrimary} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} vertical={false} />
                  <XAxis dataKey="hour" tick={{ fill: chartText, fontSize: 11 }} axisLine={{ stroke: chartGrid }} tickLine={false} interval={2} />
                  <YAxis tick={{ fill: chartText, fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={formatNumber} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="Sessions" stroke={chartPrimary} fill="url(#hourlyGrad)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="section">
            <div className="section-header">
              <h2 className="section-title">Top Tools</h2>
            </div>
            <div className="section-subtitle">Most frequently used tools across all sessions</div>
            <div className="chart-card">
              {data.topTools.length === 0 ? (
                <MutedText>No tool usage recorded.</MutedText>
              ) : data.topTools.map((tool, i) => (
                <ModelBar
                  key={tool.name}
                  name={tool.name}
                  value={tool.count}
                  max={data.topTools[0].count}
                  color={COLORS[i % COLORS.length]}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {activeTab === 'trends' && <TrendsTab data={data} />}

      {activeTab === 'models' && (
        <>
          <div className="section">
            <div className="section-header">
              <h2 className="section-title">Model Token Distribution</h2>
            </div>
            <div className="section-subtitle">Share of total tokens by model</div>
            <div className="chart-row">
              <div className="chart-card">
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={modelPieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {modelPieData.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                    <Legend verticalAlign="bottom" height={36} iconType="circle" />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="chart-card">
                <h3 className="card-heading">Model Breakdown</h3>
                {data.modelStats.map((m, i) => (
                  <ModelBar
                    key={m.name}
                    name={m.name}
                    value={m.tokens}
                    max={maxModelTokens}
                    color={COLORS[i % COLORS.length]}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-header">
              <h2 className="section-title">Thinking Levels</h2>
            </div>
            <div className="section-subtitle">Distribution of thinking level changes</div>
            <div className="chart-card">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {data.thinkingLevelDistribution.map((t) => (
                  <span key={t.name} className="tag">{t.name}: {formatInteger(t.count)}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-header">
              <h2 className="section-title">Stop Reasons</h2>
            </div>
            <div className="section-subtitle">Why assistant messages ended</div>
            <div className="chart-card">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {data.stopReasonDistribution.map((s) => (
                  <span key={s.name} className="tag">{s.name}: {formatInteger(s.count)}</span>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {activeTab === 'efficiency' && <ModelEfficiencyTab data={data} />}

      {activeTab === 'projects' && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Project Breakdown</h2>
            <select
              className="compact-control"
              value={projectSort}
              onChange={e => setProjectSort(e.target.value as typeof projectSort)}
            >
              <option value="messages">Sort: Messages</option>
              <option value="sessions">Sort: Sessions</option>
              <option value="tokens">Sort: Tokens</option>
              <option value="cost">Sort: Cost</option>
            </select>
          </div>
          <div className="section-subtitle">Sessions, messages, and cost by project</div>
          <div className="chart-card">
            {sortedProjects.map((p, i) => (
              <div key={p.name} className="project-row">
                <div className="project-row-header">
                  <span className="project-name">{p.name}</span>
                  <div className="project-meta">
                    <span>{formatInteger(p.sessions)} sessions</span>
                    <span>{formatNumber(p.messages)} msgs</span>
                    <span>{formatNumber(p.tokens)} tokens</span>
                    <span className="cost">{formatCost(p.cost)}</span>
                  </div>
                </div>
                <ModelBar
                  name=""
                  value={p[projectSort]}
                  max={Math.max(...sortedProjects.map(x => x[projectSort]), 1)}
                  color={COLORS[i % COLORS.length]}
                  formatValue={projectSort === 'cost' ? formatCost : formatNumber}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'sessions' && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Recent Sessions</h2>
            <input
              className="compact-control session-search"
              type="text"
              placeholder="Filter by project or date…"
              value={sessionFilter}
              onChange={e => setSessionFilter(e.target.value)}
            />
          </div>
          <div className="section-subtitle">
            {filteredSessions.length === data.totalSessions
              ? `All ${formatInteger(data.totalSessions)} sessions sorted by date`
              : `${formatInteger(filteredSessions.length)} of ${formatInteger(data.totalSessions)} sessions`}
          </div>
          <div className="chart-card" style={{ overflowX: 'auto' }}>
            <table className="session-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Project</th>
                  <th>Messages</th>
                  <th>Tokens</th>
                  <th>Duration</th>
                  <th>Cost</th>
                  <th>Models</th>
                </tr>
              </thead>
              <tbody>
                {filteredSessions.map(sess => (
                  <tr key={sess.id}>
                    <td style={{ whiteSpace: 'pre', minWidth: '110px' }}>{localDateTime(sess.startTime)}</td>
                    <td>{sess.projectName}</td>
                    <td className="num">{formatInteger(sess.messageCount)}</td>
                    <td className="num">{formatNumber(sess.tokenUsage.total)}</td>
                    <td className="num">{formatDuration(sess.duration)}</td>
                    <td className="num cost">{formatCost(sess.cost.total)}</td>
                    <td>
                      {Object.keys(sess.models).map(m => (
                        <span key={m} className="tag" style={{ marginRight: '4px' }}>{m}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'rage' && (
        <RageTab rage={data.rageStats} totalUserMessages={data.totalMessages} />
      )}

      {activeTab === 'recommendations' && <RecommendationsTab data={data} />}
      {activeTab === 'savings' && <SavingsTab report={data.savings} />}

      <div className="footer">
        Generated by Felan Insights · {new Date().toLocaleString()}
      </div>
    </div>
  );
}

export default App;
