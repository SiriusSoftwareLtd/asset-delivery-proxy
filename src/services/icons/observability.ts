// observability.ts

import { type LogLevel, parseReportLevel, shouldReport } from '../../middleware/observability';

export type IconLogger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

export function logIconEvent(
  logger: IconLogger,
  level: LogLevel,
  event: string,
  fields: Record<string, unknown>,
  reportLevel: string,
): void {
  if (!shouldReport(level, parseReportLevel(reportLevel))) {
    return;
  }

  logger[level]({
    event,
    ...fields,
  });
}
