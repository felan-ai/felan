export interface OutputMetricRecord {
  readonly timestamp: string;
  readonly tool: string;
  readonly techniques: string;
  readonly originalChars: number;
  readonly filteredChars: number;
  readonly savingsPercent: number;
}

export class OutputMetrics {
  readonly #records: OutputMetricRecord[] = [];

  track(original: string, filtered: string, tool: string, techniques: readonly string[]): OutputMetricRecord {
    const originalChars = original.length;
    const filteredChars = filtered.length;
    const savingsPercent =
      originalChars === 0 ? 0 : Math.round(((originalChars - filteredChars) / originalChars) * 10_000) / 100;
    const record = {
      timestamp: new Date().toISOString(),
      tool,
      techniques: techniques.join(',') || 'none',
      originalChars,
      filteredChars,
      savingsPercent,
    };
    this.#records.push(record);
    return record;
  }

  clear(): void {
    this.#records.length = 0;
  }

  summary(): string {
    if (this.#records.length === 0) return 'RTK output compaction metrics: no data yet.';

    const totalOriginal = sum(this.#records, (record) => record.originalChars);
    const totalFiltered = sum(this.#records, (record) => record.filteredChars);
    const totalSaved = totalOriginal - totalFiltered;
    const savingsPercent = totalOriginal === 0 ? 0 : (totalSaved / totalOriginal) * 100;
    const byTool = new Map<string, { count: number; original: number; filtered: number }>();

    for (const record of this.#records) {
      const current = byTool.get(record.tool) ?? { count: 0, original: 0, filtered: 0 };
      current.count += 1;
      current.original += record.originalChars;
      current.filtered += record.filteredChars;
      byTool.set(record.tool, current);
    }

    return [
      'RTK output compaction metrics',
      `calls=${this.#records.length}, saved=${totalSaved.toLocaleString()} chars (${savingsPercent.toFixed(1)}%)`,
      ...[...byTool].map(([tool, current]) => {
        const saved = current.original - current.filtered;
        const percent = current.original === 0 ? 0 : (saved / current.original) * 100;
        return `- ${tool}: ${current.count} calls, saved ${saved.toLocaleString()} chars (${percent.toFixed(1)}%)`;
      }),
    ].join('\n');
  }
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}
