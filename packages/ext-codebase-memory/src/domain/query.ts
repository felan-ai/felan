import type { CbmClient } from '../cbm/client.js';
import type { ToolTextResult } from '../cbm/result.js';
import type { OutputService } from './output.js';
import type { ProjectService, ToolExecutionContext } from './project.js';

export class QueryService {
  constructor(private readonly cbm: CbmClient, private readonly projects: ProjectService, private readonly output: OutputService) {}

  async execute(title: string, command: string, params: Readonly<Record<string, unknown>>, ctx: ToolExecutionContext): Promise<ToolTextResult> {
    const project = typeof params.project === 'string' ? params.project : await this.projects.inferProject(ctx.cwd, ctx.signal);
    const result = await this.cbm.callTool(command, { ...params, project }, { signal: ctx.signal });
    return this.output.result(title, result.data);
  }
}
