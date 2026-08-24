# Powerline Extension

- Install only when `ctx.mode === 'tui'`; headless modes perform no footer or Git work. Shutdown disposes and clears the footer.
- Keep rendering ANSI-visible-width safe across alignment, wrapping, styles, charsets, and color modes.
- Git probes use `pi.exec` and remain asynchronous, cached, coalesced, and time-bounded. Add no direct filesystem, network, or private-credential integrations.
