import type { Analytics } from "./types.js";

export function generateMarkdown(analytics: Analytics): string {
  const lines: string[] = ["# Felan Code Insights Report", ""];

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

  addModelEfficiency(lines, analytics);

  addTable(lines, "Tools", ["Tool", "Calls"], analytics.topTools.slice(0, 10).map(tool => [
    tool.name,
    formatNumber(tool.count),
  ]));

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function addModelEfficiency(lines: string[], analytics: Analytics): void {
  const efficiency = analytics.modelEfficiency;
  if (!efficiency) return;

  addTable(lines, "Efficiency", ["Model", "Sessions", "Messages", "Tokens", "Cost", "Cost/token", "Cost/message", "Avg duration", "Tool error rate"], efficiency.models.slice(0, 10).map(model => [
    model.model,
    formatNumber(model.sessions),
    formatNumber(model.messages),
    formatNumber(model.tokens),
    formatCurrency(model.cost),
    formatCurrency(model.costPerToken),
    formatCurrency(model.costPerMessage),
    formatDuration(model.avgSessionDuration),
    model.toolErrorRate === undefined ? "n/a" : formatPercent(model.toolErrorRate),
  ]), "###");
}

function addTable(lines: string[], title: string, headers: string[], rows: string[][], heading: "##" | "###" = "##"): void {
  lines.push(`${heading} ${title}`, "");
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

function formatCurrency(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 0.1 ? 2 : 4;
  return `${value < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
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
