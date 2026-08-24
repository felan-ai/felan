# Web Access Extension

- This package owns host-side web search, remote HTTP(S) fetching, and DNS validation. Configuration arrives through the declarative extension settings; direct host HTTP/DNS remain intentional exceptions to Felan's adapter-neutral I/O rule.
- Route repository, workspace, storage, and process operations through `AgentRuntime`, `pi.runtime`, or `pi.exec`. Do not use direct child-process or workspace filesystem APIs.
- Block private, loopback, link-local, reserved, and internal network destinations by default. Revalidate DNS and every redirect; only trusted user-owned `ssrf.allowRanges` configuration may grant narrow exceptions.
- Treat every remote text, metadata, image, PDF, repository file, provider response, and derived summary as untrusted external data at every model boundary.
