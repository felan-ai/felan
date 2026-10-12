export const INSIGHTS_REPORT_PRESENTER = Object.freeze({ id: 'felan.insights-report', version: '1' });
export interface InsightsReportRequest { path: string }
export interface InsightsReportResult { opened: boolean }
export interface InsightsReportPresentation { openReport(path: string, signal?: AbortSignal): Promise<void> }
export function parseInsightsReportRequest(value: unknown): InsightsReportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('path' in value)) throw new Error('Invalid insights report request.');
  const path = value.path;
  if (typeof path !== 'string' || new TextEncoder().encode(path).length > 4096
    || !/^(?:\/(?!\/)|[a-zA-Z]:[\\/])/u.test(path) || /[\u0000-\u001f\u007f-\u009f]/u.test(path)
    || path.split(/[\\/]/u).some(part => part === '.' || part === '..')
    || !/[\\/]insights-reports[\\/]felan-insights\.html$/u.test(path)) throw new Error('Invalid insights report path.');
  return { path };
}
export function parseInsightsReportResult(value: unknown): InsightsReportResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('opened' in value) || typeof value.opened !== 'boolean') throw new Error('Invalid insights report result.');
  return { opened: value.opened };
}
