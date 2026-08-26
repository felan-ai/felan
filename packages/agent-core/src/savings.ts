export type SavingsCategory =
  | 'output-optimization'
  | 'model-routing'
  | 'context-management'
  | 'other';

export interface SavingsModelReference {
  readonly provider: string;
  readonly id: string;
}

export interface SavingsTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cacheWrite1h?: number;
}

export interface SavingsOutcome {
  readonly costUsd?: number;
  readonly model?: SavingsModelReference;
  readonly tokens?: SavingsTokenUsage;
}

export interface SavingsMeasurement {
  readonly category: SavingsCategory;
  readonly operation?: string;
  readonly baseline: SavingsOutcome;
  readonly actual: SavingsOutcome;
  readonly basis: {
    readonly kind: 'observed-comparison' | 'estimated-baseline';
    readonly method: string;
  };
  readonly calls?: number;
  readonly dimensions?: {
    readonly tool?: string;
    readonly techniques?: readonly string[];
  };
}

export interface SavingsReporter {
  report(measurement: SavingsMeasurement): Promise<void>;
}

/** Host-side factory. Extensions receive only their producer-bound reporter. */
export interface SavingsReporterProvider {
  createReporter(producerId: string): SavingsReporter;
}
