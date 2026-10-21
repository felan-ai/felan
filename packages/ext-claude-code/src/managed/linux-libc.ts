export function detectLinuxLibc(getReport: () => unknown = () => process.report?.getReport()): 'glibc' | 'musl' {
  const report = getReport();
  const header = typeof report === 'object' && report !== null && 'header' in report ? report.header : undefined;
  return typeof header === 'object' && header !== null && 'glibcVersionRuntime' in header
    ? 'glibc'
    : 'musl';
}
