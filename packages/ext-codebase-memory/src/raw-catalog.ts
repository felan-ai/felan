import { Type, type TObject } from 'typebox';
import { Check } from 'typebox/value';

// Static schemas from codebase-memory-mcp 0.10.8, src/mcp/mcp.c at
// 46ae198fc11cda80e817acbc5f5908d7c2de7032. Project selection and full indexing
// are host-controlled; backend defaults are documented but never applied here.
export const RAW_COMMANDS = [
  'index_repository',
  'search_graph',
  'query_graph',
  'trace_path',
  'get_graph_schema',
  'get_architecture',
  'index_status',
  'check_index_coverage',
  'detect_changes',
  'get_code_snippet',
  'search_code',
  'list_projects',
] as const;

export type RawCommand = typeof RAW_COMMANDS[number];
export type CodebaseMemoryMode = 'curated' | 'direct' | 'proxy';
export const RAW_COMMAND_SCHEMA = Type.Union(RAW_COMMANDS.map((command) => Type.Literal(command)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]);

export const RAW_TOOL_CATALOG: ReadonlyArray<{
  name: RawCommand;
  description: string;
  parameters: TObject;
  projectScoped: boolean;
}> = [
  {
    name: 'index_repository',
    description: 'Fully index the current repository into the knowledge graph. Coverage metadata is best-effort; missing flags do not guarantee completeness.',
    parameters: Type.Object({
      repo_path: Type.Optional(Type.String({ minLength: 1, description: 'Path to the repository. Omit to index the current repository.' })),
    }, { additionalProperties: false }),
    projectScoped: false,
  },
  {
    name: 'search_graph',
    description: 'Search graph definitions and relationships using BM25 query, regex patterns, or semantic keyword arrays. Results are paginated via offset and limit; inspect total and has_more.',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: 'Current project. May be omitted; the host injects it and rejects a different project.' })),
      query: Type.Optional(Type.String({ description: 'Natural-language or keyword full-text search using BM25 ranking. Tokens are split on whitespace; camelCase identifiers are indexed as individual words (updateCloudClient → update, cloud, client). Results are ranked with structural boosting: Functions/Methods +10, Routes +8, Classes/Interfaces +5. Noise labels (File/Folder/Module/Variable) are filtered out. When provided, name_pattern is ignored.' })),
      label: Type.Optional(Type.String()),
      name_pattern: Type.Optional(Type.String()),
      qn_pattern: Type.Optional(Type.String()),
      file_pattern: Type.Optional(Type.String()),
      relationship: Type.Optional(Type.String()),
      min_degree: Type.Optional(Type.Integer()),
      max_degree: Type.Optional(Type.Integer()),
      exclude_entry_points: Type.Optional(Type.Boolean()),
      include_connected: Type.Optional(Type.Boolean()),
      semantic_query: Type.Optional(Type.Array(Type.String(), {description: 'MUST be an ARRAY of keyword strings (e.g. ["send","pubsub","publish"]) — NOT a single string. Each keyword is scored independently via per-keyword min-cosine; results reflect functions that score well on ALL keywords. Requires moderate/full index mode. Results appear in the \'semantic_results\' field (separate from \'results\').' })),
      limit: Type.Optional(Type.Integer({ description: 'Max results per call. Default 50. Response carries \'total\' (full match count) and \'has_more\' (true if truncated) so callers can detect the limit and paginate.' })),
      offset: Type.Optional(Type.Integer({ default: 0, description: 'Skip the first N matching nodes. Combine with \'limit\' to page: increment offset by limit and re-call while has_more is true.' })),
      format: Type.Optional(Type.Union([Type.Literal('tree'), Type.Literal('json')], {default: 'tree', description: 'Response encoding. tree (default): prefix-grouped text rows. json: the SAME tree model as structured JSON (groups + column-ordered row arrays).' })),
      fields: Type.Optional(Type.Array(Type.String(), {description: 'Extra per-node property columns, e.g. complexity, cognitive, signature, docstring, return_type, is_test, lines(int). Core row columns (qn/label/file/lines/in/out) are always present — do not request them here. Missing values emit as empty cells.' })),
      detail: Type.Optional(Type.Union([Type.Literal('ids'), Type.Literal('default')], {default: 'default', description: 'ids: bare qualified-name enumeration (one column) — cheapest form for wide sweeps where per-row metadata is noise. default: full rows.' })),
    }, { additionalProperties: false }),
    projectScoped: true,
  },
  {
    name: 'query_graph',
    description: 'Execute a Cypher query for graph patterns and aggregations. Results have a hard 100k row ceiling; use LIMIT or search_graph pagination for broad queries.',
    parameters: Type.Object({
      query: Type.String({ description: 'Cypher query'}),
      project: Type.Optional(Type.String({ description: 'Current project. May be omitted; the host injects it and rejects a different project.' })),
      graph: Type.Optional(Type.Union([Type.Literal('code'), Type.Literal('missed')], {default: 'code', description: 'Which graph to query: the code knowledge graph (default) or the missed graph (only files not fully indexed, laid out as their file structure).' })),
      max_rows: Type.Optional(Type.Integer({ description: 'Optional row limit. Default: unlimited up to a 100k row ceiling. No offset support — use search_graph for paginated browsing.' })),
    }, { additionalProperties: false }),
    projectScoped: true,
  },
  {
    name: 'trace_path',
    description: 'Trace callers, callees, data flow, or cross-service paths from a function. Results support bounded pages and continuation cursors.',
    parameters: Type.Object({
      function_name: Type.String(),
      project: Type.Optional(Type.String({ description: 'Current project. May be omitted; the host injects it and rejects a different project.' })),
      direction: Type.Optional(Type.Union([Type.Literal('inbound'), Type.Literal('outbound'), Type.Literal('both')], {default: 'both' })),
      depth: Type.Optional(Type.Integer({ default: 3 })),
      limit: Type.Optional(Type.Integer({ default: 100, minimum: 1, maximum: 5000, description: 'Rows per page. callees_total/callers_total always carry the exact full counts; when a page is truncated the response carries next — see cursor.' })),
      cursor: Type.Optional(Type.String({ description: 'Resume token from a previous response\'s \'next\' field. Pass it back with ALL other arguments identical to get the following page with no duplicates. Cursors outlive nothing: after a reindex you get a stale_cursor error — just re-run the original query.' })),
      mode: Type.Optional(Type.Union([Type.Literal('calls'), Type.Literal('data_flow'), Type.Literal('cross_service')], {default: 'calls', description: 'calls: follow CALLS edges. data_flow: follow CALLS+DATA_FLOWS with arg expressions. cross_service: follow HTTP_CALLS+ASYNC_CALLS+DATA_FLOWS through Routes, plus CROSS_* cross-repo edges (CROSS_HTTP_CALLS/ASYNC_CALLS/CHANNEL/GRPC_CALLS/GRAPHQL_CALLS/TRPC_CALLS) to hop into other services.' })),
      parameter_name: Type.Optional(Type.String({ description: 'For data_flow mode: scope trace to a specific parameter name' })),
      edge_types: Type.Optional(Type.Array(Type.String())),
      risk_labels: Type.Optional(Type.Boolean({ default: false, description: 'Add risk classification (CRITICAL/HIGH/MEDIUM/LOW) based on hop distance' })),
      include_tests: Type.Optional(Type.Boolean({ default: false, description: 'Include test files in results. When false (default), test files are filtered out. When true, test nodes are included with a test column/marker.' })),
      format: Type.Optional(Type.Union([Type.Literal('tree'), Type.Literal('json')], {default: 'tree', description: 'Response encoding. tree (default): prefix-grouped text rows. json: the SAME tree model as structured JSON (groups + column-ordered row arrays).' })),
      include_evidence: Type.Optional(Type.Boolean({ default: false, description: 'Add how each hop was resolved: a strategy class (lsp | language_rule | heuristic | unresolved) and the resolver\'s confidence. Off by default — it adds two columns per row. Use it to judge whether an edge is trustworthy, not to find edges.' })),
    }, { additionalProperties: false }),
    projectScoped: true,
  },
  {
    name: 'get_graph_schema',
    description: 'Get graph node labels, relationship types, and properties for constructing queries.',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: 'Current project. May be omitted; the host injects it and rejects a different project.' })),
    }, { additionalProperties: false }),
    projectScoped: true,
  },
  {
    name: 'get_architecture',
    description: 'Get architecture summaries, directory structure, dependencies, and selected architectural aspects.',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: 'Current project. May be omitted; the host injects it and rejects a different project.' })),
      path: Type.Optional(Type.String({ description: 'Optional directory prefix to scope architecture (e.g. apps/hoa)' })),
      aspects: Type.Optional(Type.Array(Type.Union([Type.Literal('all'), Type.Literal('overview'), Type.Literal('structure'), Type.Literal('dependencies'), Type.Literal('routes'), Type.Literal('languages'), Type.Literal('packages'), Type.Literal('entry_points'), Type.Literal('hotspots'), Type.Literal('boundaries'), Type.Literal('layers'), Type.Literal('file_tree'), Type.Literal('clusters'), Type.Literal('cycles')]), {description: 'Aspects to include. \'all\' = everything; \'overview\' = compact summary (all except file_tree); omit = all. \'cycles\' is opt-in ONLY (never via all/overview): it scans the whole call graph for circular CALLS dependencies (SCCs of size > 1).' })),
    }, { additionalProperties: false }),
    projectScoped: true,
  },
  {
    name: 'index_status',
    description: 'Get indexing status and best-effort coverage metadata, including skipped, partially parsed, and deliberately excluded files.',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: 'Current project. May be omitted; the host injects it and rejects a different project.' })),
      verbose: Type.Optional(Type.Boolean({ default: false, description: 'Include the git context block (worktree/shadow path variants). Only needed when debugging where an index lives — omitted by default to keep the status lean.' })),
    }, { additionalProperties: false }),
    projectScoped: true,
  },
  {
    name: 'check_index_coverage',
    description: 'Check authoritative coverage metadata for repository-relative paths or bounded scopes. At least one of paths or scopes is required by the backend. Absence of recorded gaps does not guarantee completeness.',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: 'Current project. May be omitted; the host injects it and rejects a different project.' })),
      paths: Type.Optional(Type.Array(Type.String(), {maxItems: 128, description: 'Repository-relative files to check exactly. Required if \'scopes\' is omitted.' })),
      scopes: Type.Optional(Type.Array(Type.String(), {maxItems: 32, description: 'Repository-relative path prefixes; use . for the project root. Required if \'paths\' is omitted.' })),
      scope_limit: Type.Optional(Type.Integer({ default: 200, minimum: 1, maximum: 1000 })),
      scope_offset: Type.Optional(Type.Integer({ default: 0, minimum: 0 })),
    }, { additionalProperties: false }),
    projectScoped: true,
  },
  {
    name: 'detect_changes',
    description: 'Map a git diff to changed files and transitive graph impact. Inspect impacted_total and truncated for result completeness.',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: 'Current project. May be omitted; the host injects it and rejects a different project.' })),
      scope: Type.Optional(Type.Union([Type.Literal('files'), Type.Literal('impact')], {description: 'files: changed files only (no traversal). impact (default): files + the transitive impact set.' })),
      direction: Type.Optional(Type.Union([Type.Literal('inbound'), Type.Literal('outbound'), Type.Literal('both')], {default: 'inbound', description: 'inbound (default) = the blast radius: transitive CALLERS of the changed symbols. outbound = what the changed code depends on. both = union.' })),
      depth: Type.Optional(Type.Integer({ default: 2, description: 'Max traversal hops from the changed symbols.' })),
      limit: Type.Optional(Type.Integer({ default: 200, maximum: 5000, description: 'Per-symbol impacted rows shown (nearest hops first). impacted_total is always exact and the impacted_modules rollup always complete regardless.' })),
      base_branch: Type.Optional(Type.String({ default: 'main' })),
      since: Type.Optional(Type.String({ description: 'Git ref or tag to compare from (e.g. HEAD~5, v0.5.0). Diffs <ref>...HEAD.' })),
      format: Type.Optional(Type.Union([Type.Literal('tree'), Type.Literal('json')], {default: 'tree' })),
    }, { additionalProperties: false }),
    projectScoped: true,
  },
  {
    name: 'get_code_snippet',
    description: 'Read source code for a symbol. First use search_graph to find its qualified_name; whole-file results are capped by the backend.',
    parameters: Type.Object({
      qualified_name: Type.String({ description: 'Full qualified_name from search_graph, or short function name'}),
      project: Type.Optional(Type.String({ description: 'Current project. May be omitted; the host injects it and rejects a different project.' })),
      include_neighbors: Type.Optional(Type.Boolean({ default: false })),
    }, { additionalProperties: false }),
    projectScoped: true,
  },
  {
    name: 'search_code',
    description: 'Search repository source text with optional regex and path filters. Returns enriched symbol context; inspect total_grep_matches and total_results for truncation.',
    parameters: Type.Object({
      pattern: Type.String(),
      project: Type.Optional(Type.String({ description: 'Current project. May be omitted; the host injects it and rejects a different project.' })),
      file_pattern: Type.Optional(Type.String({ description: 'Glob for grep --include (e.g. *.go)' })),
      path_filter: Type.Optional(Type.String({ description: 'Regex filter on result file paths (e.g. ^src/ or \\.(go|ts)$)' })),
      mode: Type.Optional(Type.Union([Type.Literal('compact'), Type.Literal('full'), Type.Literal('files')], {default: 'compact', description: 'compact: signatures+metadata (default). full: with source. files: just file list.' })),
      context: Type.Optional(Type.Integer({ description: 'Lines of context around each match (like grep -C). Only used in compact mode.' })),
      regex: Type.Optional(Type.Boolean({ default: false })),
      debug: Type.Optional(Type.Boolean({ default: false, description: 'Include scope_ms, scan_ms, and enrich_ms phase timing diagnostics.' })),
      limit: Type.Optional(Type.Integer({ description: 'Max enriched results per call. Default 10. Response includes \'total_grep_matches\' and \'total_results\' so callers can detect truncation. No offset parameter — raise limit or narrow with file_pattern / path_filter to see more.', default: 10, minimum: 1 })),
    }, { additionalProperties: false }),
    projectScoped: true,
  },
  {
    name: 'list_projects',
    description: 'List indexed projects with bounded pagination and optional detailed metadata.',
    parameters: Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
      include_details: Type.Optional(Type.Boolean({ default: false, description: 'Include branch, node/edge counts and database size. Slower.' })),
      metadata_only: Type.Optional(Type.Boolean({ description: 'Deprecated compatibility alias for include_details=false.' })),
    }, { additionalProperties: false }),
    projectScoped: false,
  },
];

function commandFields(tool: { parameters: TObject }): { required: string[]; optional: string[] } {
  const required = tool.parameters.required ?? [];
  const all = Object.keys(tool.parameters.properties ?? {});
  return { required: [...required], optional: all.filter((field) => !required.includes(field)) };
}

// One `name(required, optional?)` entry per command. Proxy mode erases the
// per-command schemas behind an untyped `arguments` record, so without this the
// model can only guess field names; every observed proxy failure was a wrong
// name, not a wrong type.
export function describeRawCommands(): string {
  return RAW_TOOL_CATALOG.map((tool) => {
    const { required, optional } = commandFields(tool);
    return `${tool.name}(${[...required, ...optional.map((field) => `${field}?`)].join(', ')})`;
  }).join('; ');
}

export function validateRawArguments(command: string, args: unknown): Record<string, unknown> {
  const tool = RAW_TOOL_CATALOG.find((entry) => entry.name === command);
  if (!tool) {
    throw new Error(`Unsupported Codebase Memory command: ${command.slice(0, 80)}`);
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`Invalid arguments for ${tool.name}: expected an object.`);
  }
  if (!Check(tool.parameters, args)) {
    // Name every accepted field so a retry can succeed. Schema field names only:
    // never the caller's argument values.
    const { required, optional } = commandFields(tool);
    throw new Error(
      `Invalid arguments for ${tool.name}: expected the command schema; required fields: ${required.join(', ') || 'none'};`
      + ` optional fields: ${optional.join(', ') || 'none'}. Unknown fields are not allowed.`,
    );
  }
  return args as Record<string, unknown>;
}
