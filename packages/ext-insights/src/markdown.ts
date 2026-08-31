import type { AiInsights, Analytics, InsightFlag, InsightRecommendation } from "./types.js";

export function generateMarkdown(analytics: Analytics): string {
  const lines: string[] = ["# Pi Insights Report", ""];

  if (analytics.export?.generatedAt) {
    lines.push(`Generated: ${analytics.export.generatedAt}`, "");
  }

  lines.push(`Date range: ${dateRange(analytics)}`, "", "## Overview", "");
  lines.push(
    `- Sessions: ${formatNumber(analytics.totalSessions)}`,
    `- Messages: ${formatNumber(analytics.totalMessages)}`,
    `- Tokens: ${formatNumber(analytics.totalTokens)}`,
    `- Cost: ${formatCurrency(analytics.totalCost)}`,
    `- Total duration: ${formatDuration(analytics.totalDuration)}`,
    `- Average session duration: ${formatDuration(analytics.avgSessionDuration)}`,
    `- Average messages/session: ${formatNumber(analytics.avgMessagesPerSession)}`,
    `- Model-switching sessions: ${formatNumber(analytics.modelSwitchCount)}`,
    `- Rage hits: ${formatNumber(analytics.rageStats.total)}`,
    ""
  );

  addTable(lines, "Projects", ["Project", "Sessions", "Messages", "Tokens", "Cost", "Duration"], analytics.projectStats.slice(0, 10).map(project => [
    project.name,
    formatNumber(project.sessions),
    formatNumber(project.messages),
    formatNumber(project.tokens),
    formatCurrency(project.cost),
    formatDuration(project.duration),
  ]));

  addTable(lines, "Models", ["Model", "Messages", "Tokens", "Cost", "Avg duration"], analytics.modelStats.slice(0, 10).map(model => [
    model.name,
    formatNumber(model.count),
    formatNumber(model.tokens),
    formatCurrency(model.cost),
    formatDuration(model.avgDuration),
  ]));

  addTable(lines, "Tools", ["Tool", "Calls"], analytics.topTools.slice(0, 10).map(tool => [
    tool.name,
    formatNumber(tool.count),
  ]));

  addTemporalInsights(lines, analytics);
  addModelEfficiency(lines, analytics);
  addDeterministicAnalysis(lines, analytics);
  addAiRecommendations(lines, analytics.ai);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function addTemporalInsights(lines: string[], analytics: Analytics): void {
  const temporal = analytics.temporal;
  if (!temporal) return;

  lines.push("## Temporal insights", "");

  if (temporal.weekOverWeek) {
    lines.push(`- Week over week (${temporal.weekOverWeek.currentStart} vs ${temporal.weekOverWeek.previousStart}): sessions ${formatSignedNumber(temporal.weekOverWeek.sessionsDelta)}, cost ${formatSignedCurrency(temporal.weekOverWeek.costDelta)}, tool errors ${formatSignedNumber(temporal.weekOverWeek.toolErrorDelta)}.`);
  }

  if (temporal.trajectory) {
    lines.push(`- Trajectory: cost ${temporal.trajectory.cost}; errors ${temporal.trajectory.errors}.`);
  }

  if (temporal.decayWeightedActivity) {
    const weighted = temporal.decayWeightedActivity;
    lines.push(`- Decay-weighted activity: ${formatNumber(weighted.sessions)} sessions, ${formatNumber(weighted.messages)} messages, ${formatNumber(weighted.tokens)} tokens, ${formatCurrency(weighted.cost)}.`);
  }

  lines.push("");
  addFlags(lines, "Anomalies", temporal.anomalies ?? []);
  addFlags(lines, "Ongoing friction", temporal.deterministicFriction?.ongoing ?? []);
  addFlags(lines, "Resolved friction", temporal.deterministicFriction?.resolved ?? []);
}

function addModelEfficiency(lines: string[], analytics: Analytics): void {
  const efficiency = analytics.modelEfficiency;
  if (!efficiency) return;

  addTable(lines, "Model efficiency", ["Model", "Sessions", "Messages", "Tokens", "Cost", "Cost/token", "Cost/message", "Avg duration", "Tool error rate"], efficiency.models.slice(0, 10).map(model => [
    model.model,
    formatNumber(model.sessions),
    formatNumber(model.messages),
    formatNumber(model.tokens),
    formatCurrency(model.cost),
    formatCurrency(model.costPerToken),
    formatCurrency(model.costPerMessage),
    formatDuration(model.avgSessionDuration),
    model.toolErrorRate === undefined ? "n/a" : formatPercent(model.toolErrorRate),
  ]));

  if (efficiency.recommendations.length > 0) {
    lines.push("### Model efficiency recommendations", "");
    for (const recommendation of efficiency.recommendations) {
      lines.push(`- ${inline(recommendation)}`);
    }
    lines.push("");
  }
}

function addDeterministicAnalysis(lines: string[], analytics: Analytics): void {
  const analysis = analytics.analysis;
  if (!analysis) return;

  lines.push("## Analysis and recommendations", "");
  addFlags(lines, "Key takeaways", analysis.takeaways);
  addRecommendations(lines, "Recommended next steps", analysis.recommendations);
  addRecommendations(lines, "Consider stopping", analysis.stopDoing);

  if (analysis.takeaways.length === 0 && analysis.recommendations.length === 0 && analysis.stopDoing.length === 0) {
    lines.push("_No deterministic recommendations were generated._", "");
  }
}

function addAiRecommendations(lines: string[], ai: AiInsights | undefined): void {
  if (!ai || (ai.status !== "available" && ai.status !== "partial")) return;

  lines.push("## AI recommendations", "", `Status: ${ai.status}`);
  if (ai.sourceRange) lines.push(`Source range: ${ai.sourceRange.start} to ${ai.sourceRange.end}`);
  if (ai.cacheState) lines.push(`Cache: ${ai.cacheState}`);
  lines.push("");

  addRecommendations(lines, "Recommendations", ai.recommendations);
  addRecommendations(lines, "Stop doing", ai.stopDoing);

  if (ai.recommendations.length === 0 && ai.stopDoing.length === 0) {
    lines.push("_No AI recommendations were generated._", "");
  }
}

function addTable(lines: string[], title: string, headers: string[], rows: string[][]): void {
  lines.push(`## ${title}`, "");
  if (rows.length === 0) {
    lines.push("_No data._", "");
    return;
  }

  lines.push(
    tableRow(headers),
    tableRow(headers.map((_, index) => index === 0 ? "---" : "---:")),
    ...rows.map(tableRow),
    ""
  );
}

function addFlags(lines: string[], title: string, flags: InsightFlag[]): void {
  if (flags.length === 0) return;
  lines.push(`### ${title}`, "");
  for (const flag of flags) {
    lines.push(`- ${flag.severity}: ${inline(flag.title)} — ${inline(flag.detail)}`);
  }
  lines.push("");
}

function addRecommendations(lines: string[], title: string, recommendations: InsightRecommendation[]): void {
  if (recommendations.length === 0) return;
  lines.push(`### ${title}`, "");
  for (const recommendation of recommendations) {
    const category = recommendation.category ? ` (${recommendation.category})` : "";
    lines.push(`- ${inline(recommendation.title)}${category} — ${inline(recommendation.detail)}`);
  }
  lines.push("");
}

function tableRow(cells: string[]): string {
  return `| ${cells.map(tableCell).join(" | ")} |`;
}

function tableCell(value: string): string {
  return inline(value).replace(/\|/g, "\\|");
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dateRange(analytics: Analytics): string {
  if (!analytics.dateRange.start && !analytics.dateRange.end) return "n/a";
  return `${analytics.dateRange.start} to ${analytics.dateRange.end}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function formatCurrency(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 0.1 ? 2 : 4;
  return `${value < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}

function formatSignedCurrency(value: number): string {
  return value > 0 ? `+${formatCurrency(value)}` : formatCurrency(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
