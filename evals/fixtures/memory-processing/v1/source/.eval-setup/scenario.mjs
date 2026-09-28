export function memoryProcessingScenario() {
  const first = [
    { id: 'remember-old', role: 'user', content: 'Remember that the release check uses the old login-only rule.' },
    { id: 'provider-incident', role: 'user', content: 'During the auth incident, the provider reported success for a request it discarded. This is not documented in the repository.' },
    ...Array.from({ length: 180 }, (_, index) => ({
      id: `routine-${index}`,
      role: 'toolResult',
      toolName: 'bash',
      content: `Routine build progress ${index}: ${'unrelated build output '.repeat(15)}`,
    })),
  ];
  const second = [
    { id: 'forget-old', role: 'user', content: 'Forget the old login-only release rule; it was superseded.' },
    { id: 'remember-new', role: 'user', content: 'Remember the release smoke rule: check successful login AND blocked-account login.' },
  ];
  return {
    sessions: [
      { id: 'memory-processing-first', entries: first },
      { id: 'memory-processing-second', entries: second },
    ],
    priorWiki: [
      { path: 'summary.md', content: '# Memory summary\n\nRelease checks only need a successful login.\n' },
      { path: 'index.md', content: '# Memory index\n\n## How to use this memory\n\n## Memory map\n- [Decisions](.memory/pages/decisions/index.md)\n' },
      { path: 'pages/decisions/index.md', content: '# Decisions\n\n- [Release checks](release.md)\n- [Temporary pause](pause.md)\n' },
      { path: 'pages/decisions/release.md', content: '# Release checks\n\nOnly successful login needs checking.\n\n## Sources\n- session:prior\n' },
      { path: 'pages/decisions/pause.md', content: '# Temporary pause\n\nA release was paused for a one-off review.\n\n## Sources\n- session:prior\n' },
    ],
    expected: {
      retained: ['blocked-account login', 'provider reported success for a request it discarded'],
      superseded: ['Only successful login needs checking.', 'Release checks only need a successful login.'],
      stalePage: 'pages/decisions/pause.md',
      sourceIds: ['memory-processing-first', 'memory-processing-second'],
    },
  };
}
