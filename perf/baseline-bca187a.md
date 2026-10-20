# Investigation baseline: bca187a

Measured with the **investigation scripts**, before the performance changes, on **Apple M5 Pro / macOS 26.6.2 / Node 22.20.0**, at commit **bca187a**. These are historical observations supplied with the investigation, not measurements produced by the maintained suite. Fixtures, sample windows and instrumentation differ; do not use them as regression thresholds without a matched rerun.

| Metric | Observed baseline |
| --- | --- |
| Unix / TCP / WebSocket RTT p50 | 12.5 / 26.8 / 39.7 µs |
| 50k Unix deltas, per-frame / batched | 31 / 22 ms |
| 50k TCP deltas, per-frame / batched | 102 / 10.6 ms |
| 50k WebSocket deltas, per-frame / batched | 117 / 11.3 ms |
| `host.status` RTT | 0.8 ms |
| `sessions.list` RTT | 0.26 ms |
| Provider token → client, p50 / p99 | 0.2–0.3 / 1–3 ms |
| Provider token → TUI, p50 / p99 | 9.5–13 / 18–31 ms |
| Keystroke echo p50, idle / streaming | 0.9–1.8 / 0.9–2.8 ms |
| Prompt acknowledgement | 17–29 ms; 4–6 commits totaling 14–21 ms |
| `set_thinking` | 13–14 ms; 3 commits totaling about 10 ms |
| SQLite commit, FULL + fullfsync | 3.9 ms |
| SQLite commit, FULL, fullfsync off | 63 µs |
| SQLite commit, NORMAL, fullfsync off | 14 µs |
| Prompt → first token | 34–49 ms |
| `sessions.create` | 450–525 ms |
| TUI start → first frame, empty / 30 turns | 620–700 ms / 1.2–1.3 s |
| Idle daemon CPU | 1.65% of one core |
| 5 MiB snapshot stringify / parse | 8.9 / 7.9 ms |
| 5 MiB snapshot encodeFrame / decoder | 23 / 23 ms |
| 5 MiB `parseSessionSnapshot` | 35–37 ms |
| 5 MiB `parseServerEnvelope(attach)` | 72 ms |
| Reducer tiny event on 5 MiB state | 11.6 ms |
| Fanout burst of 1025 deltas | `resync_required` |

SQLite figures are p50 from 200 measured commits; the NORMAL case disabled fullfsync and is not the maintained suite's `shipped` configuration. TUI numbers describe PTY output arrival, not terminal paint. Token experiments used the local fake streaming provider. Results are from a single machine and include normal scheduling/measurement noise.
