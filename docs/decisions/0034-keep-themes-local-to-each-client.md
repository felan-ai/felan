# ADR 0034: Keep themes local to each client

## Status

Accepted by explicit user direction. Supersedes the theme field in the initial
daemon-backed TUI preference implementation.

## Decision

The daemon does not select, discover, load, persist, or transmit themes or
resolved palettes. A theme is client presentation state, not session state.
Each client may implement its own independent theming system.

The terminal loads its own bounded local theme configuration and approved local
theme assets. It preserves the established Felan user-theme precedence without
enabling ambient Pi resource discovery. A client may read its legacy local
theme preference for migration, but new theme changes do not modify daemon
settings. Isolated client tests use their explicit disposable configuration
root, never the developer's local theme files.

Palette application uses public rendering primitives and client-owned
components. A missing public Pi global-theme setter is not a reason to import
private SDK modules, patch global behavior, introduce daemon palette transport,
or silently declare unsupported palette rendering complete.

The terminal applies the selected text and neutral surface colors to its own
output, including erased cells, rather than relying on the shell's background.
It does not change terminal palette settings and restores default text styling
on exit. The native viewport layout keeps the editor and status visible during
resize while the transcript uses the remaining space.

Other existing preference operations are unchanged by this decision. Theme
fields are excluded from their protocol schema and rejected at that boundary.

## Consequences

Clients observing the same session can render different palettes. The daemon's
runtime composition and session recovery do not depend on installed themes.
Client rendering and bounded local theme loading require their own tests.
