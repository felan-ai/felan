export const CODEBASE_MEMORY_PROMPT = `

Codebase Memory guidance:
- The current git repository is indexed in full mode at startup; results reflect the last completed index.
- Prefer search_and_read_symbols and read_symbol for indexed symbol discovery and source; use search_code for indexed text.
- Use codebase_memory for graph, architecture, relationship, caller/callee, trace, status, and other upstream commands.
- Use raw grep/find or shell search mainly for obvious non-code files or when indexed results are unavailable.
- If you've made significant edits or CBM results look stale, refresh via codebase_memory({command: 'index_repository'}).
`;
