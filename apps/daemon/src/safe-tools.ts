export const SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'TaskGet', 'TaskList', 'ask_user', 'codebase_memory', 'enter_prewalk', 'exit_plan_mode',
  'find', 'get_subagent_result', 'grep', 'list_background_bash', 'list_subagents', 'ls',
  'read', 'read_background_bash', 'read_symbol', 'search_and_read_symbols', 'search_code',
  'session_recall', 'wait_background_bash',
]);
