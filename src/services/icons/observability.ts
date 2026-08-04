// observability.ts

import { type LogLevel, parseReportLevel, shouldReport } from '../../middleware/observability';
import type { IconLogger } from './types';

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
