# Web Access Extension

- This package owns host-side web search, remote HTTP(S) fetching, and DNS validation. Configuration arrives through the declarative extension settings; direct host HTTP/DNS remain intentional exceptions to Felan's adapter-neutral I/O rule.
- Keep the public surface to `web_search` and `fetch_content`, with no always-on capability prompt. Search discovers bounded result metadata only; selected URLs must be fetched explicitly. Content returns bounded matching text or PDF passages only.
- Route repository, workspace, storage, and process operations through `AgentRuntime`, `pi.runtime`, or `pi.exec`. Do not use direct child-process or workspace filesystem APIs.
- Block private, loopback, link-local, reserved, and internal network destinations by default. Revalidate DNS and every redirect; only trusted user-owned `ssrf.allowRanges` configuration may grant narrow exceptions.
- Web Access owns secure remote PDF retrieval and filtered passage delivery. Await every validated PDF through `felan:markitdown:pdf-convert:v1`; never add a local parser, runtime dependency on MarkItDown, or fallback. Do not add retained content, paging, session hooks, source-check summaries, GitHub checkout/raw/full-page modes, or nested answer generation.
- For fetched HTML, prefer a valid origin-root `/llms.txt` by default. Probe at most once per origin per tool call through the same SSRF, DNS-pinning, redirect, domain-policy, credential-stripping, cancellation, and timeout path. Keep invalid companion failures private, fall back to the already-fetched HTML, and preserve the `ignoreLlmsTxt` override.
- Treat every remote text, metadata, PDF, repository file, provider response, and derived summary as untrusted external data at every model boundary.
