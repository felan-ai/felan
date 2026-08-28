import type { QueryService } from './query.js';
import type { ToolExecutionContext } from './project.js';

export class TraceService {
  constructor(private readonly query: QueryService) {}
  trace(params: Readonly<Record<string, unknown>>, ctx: ToolExecutionContext) {
    return this.query.execute('Trace results', 'trace_path', params, ctx);
  }
}
