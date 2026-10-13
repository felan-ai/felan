# Powerline Extension

- Publish generic Powerline data through `pi.ui` in every session mode, including TUI, ACP, and headless sessions. Do not gate data collection or publication on a footer or client mode. Construct and install footers only in client-side TUI adapters. Shutdown cancels and joins owned work and clears published data or client footers.
- Keep rendering ANSI-visible-width safe across alignment, wrapping, styles, charsets, and color modes.
- Git probes use `pi.exec` and remain asynchronous, cached, coalesced, and time-bounded. Add no direct filesystem, network, or private-credential integrations.
