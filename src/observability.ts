import { tracing } from 'cloudflare:workers';
import { createMiddleware } from 'hono/factory';
import type { AppEnvironment, TraceSpan } from './types';

export type ReportLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';
export type LogLevel = Exclude<ReportLevel, 'off'>;
export type ReportLevelSource = string | { OBSERVABILITY_REPORT_LEVEL?: string };

const REPORT_LEVEL_PRIORITY: Record<ReportLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** Parses a configured report level. Invalid and missing values are off. */
export function parseReportLevel(value: unknown): ReportLevel {
  if (typeof value !== 'string') return 'off';

  const normalized = value.trim().toLowerCase();
  return normalized === 'off' ||
    normalized === 'error' ||
    normalized === 'warn' ||
    normalized === 'info' ||
    normalized === 'debug'
    ? normalized
    : 'off';
}

function getReportLevel(source: ReportLevelSource): ReportLevel {
  return parseReportLevel(typeof source === 'string' ? source : source.OBSERVABILITY_REPORT_LEVEL);
}

export function shouldReport(eventLevel: LogLevel, source: ReportLevelSource): boolean {
  return REPORT_LEVEL_PRIORITY[eventLevel] <= REPORT_LEVEL_PRIORITY[getReportLevel(source)];
}

export function enterTraceSpan<T>(
  name: string,
  callback: (span: TraceSpan) => T | Promise<T>,
  source: ReportLevelSource,
): T | Promise<T> {
  if (getReportLevel(source) !== 'info' && getReportLevel(source) !== 'debug') {
    return callback({ setAttribute() {} });
  }

  const tracingApi = tracing as unknown as
    | {
        enterSpan?: (spanName: string, spanCallback: (span: TraceSpan) => T | Promise<T>) => T | Promise<T>;
      }
    | undefined;

  return tracingApi?.enterSpan ? tracingApi.enterSpan(name, callback) : callback({ setAttribute() {} });
}

/** Writes a structured event to Cloudflare Workers Logs. */
export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown>,
  source: ReportLevelSource,
): void {
  if (!shouldReport(level, source)) return;

  console[level]({ event, ...fields });
}

/** Converts an unknown error into safe structured log fields. */
export function getErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      errorCause: error.cause instanceof Error ? error.cause.message : error.cause,
    };
  }

  return { errorMessage: String(error) };
}

/** Returns whether an error was produced by an aborted or timed-out fetch. */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** Adds request correlation and emits one access log per handled request. */
export const observeRequests = createMiddleware<AppEnvironment>(async (c, next) => {
  const requestId = c.req.header('CF-Ray') ?? crypto.randomUUID();
  const startedAt = performance.now();

  c.set('requestId', requestId);
  c.set('cacheStatus', 'unknown');
  c.header('X-Request-ID', requestId);

  await next();

  logEvent(
    'info',
    'request.completed',
    {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      cacheStatus: c.get('cacheStatus'),
      upstreamStatus: c.get('upstreamStatus'),
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    },
    c.env,
  );
});
