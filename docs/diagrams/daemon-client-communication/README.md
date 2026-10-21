# Daemon and client communication

An animated, step-by-step explainer of how the local daemon and its clients
talk: connecting, the wire format, the session projection, per-connection
fan-out, attach and recovery, the client reducer, control-store commits, TUI
rendering, startup, and the remote connector. Most chapters have a **Before**
mode that shows the design the performance work replaced.

Open [`index.html`](index.html) directly in a browser; it needs no build or
server. For example, on macOS:

```sh
open docs/diagrams/daemon-client-communication/index.html
```

Use Space to play or pause, ←/→ to step, ↑/↓ to change chapter and B to toggle
Before/After. Each chapter and mode has a deep link such as
`index.html#fanout:before`. The page loads its fonts from Google Fonts and falls
back to system fonts offline.

## Sources

| Chapter | Code it describes |
| --- | --- |
| 01 The big picture | `apps/daemon/src/daemon/server.ts`, `apps/felan/src/client/client.ts` |
| 02 Connecting | `apps/daemon/src/daemon/ipc.ts`, `native-ownership.ts`, `server.ts` |
| 03 Wire format | `packages/session-protocol/src/framing.ts`, `limits.ts`, `commands.ts`, `events.ts` |
| 04 Projection | `apps/daemon/src/daemon/projection.ts`, `registry.ts` |
| 05 Fan-out & batching | `apps/daemon/src/daemon/fanout.ts`, `server.ts` |
| 06 Attach & recovery | `apps/daemon/src/daemon/fanout.ts`, `packages/session-protocol/src/events.ts`, `apps/felan/src/client/client.ts`, `transport.ts` |
| 07 Client reducer | `apps/felan/src/client/reducer.ts` |
| 08 Control-store commits | `apps/daemon/src/daemon/persistence.ts`, [ADR 0042](../../decisions/0042-use-normal-synchronous-control-store-commits.md) |
| 09 TUI rendering | `apps/felan/src/tui/controller.ts`, `streaming-markdown.ts`, pinned `@earendil-works/pi-tui` |
| 10 Startup & session create | `apps/felan/src/cli-main.ts`, `client-application.ts`, `apps/daemon/src/daemon/registry.ts` |
| 11 Remote clients | `apps/daemon/src/remote/`, `packages/session-protocol/src/publication.ts`, [remote connector](../../shared-session-daemon/remote-connector.md) |

The **Proposed** mode of chapter 11 is an unadopted design sketch; nothing in it
is built.

## Measurements

Before figures come from the investigation baseline in
[`perf/baseline-bca187a.md`](../../../perf/baseline-bca187a.md). After figures
come from one full `node perf/run.mjs` run on 2026-10-16 (see the
[performance suite](../../../perf/README.md)), ADR 0042 for commit latency, and
the `FELAN_STREAMING_MARKDOWN_BENCHMARK` case in
`apps/felan/test/streaming-markdown.test.ts`. All were measured on one Apple M5
Pro with Node 22.20.0 and a local fake provider. The harnesses differ, so treat
before/after pairs as indicative rather than as regression thresholds.

When you change code listed above, update the matching chapter in
`scenes-a.js` (chapters 1–6) or `scenes-b.js` (chapters 7–11).
