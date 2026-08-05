/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type ReportLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';
export type LogLevel = Exclude<ReportLevel, 'off'>;
export type ReportLevelSource = string | { OBSERVABILITY_REPORT_LEVEL?: string };

const PRIORITY: Record<ReportLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function parseReportLevel(value: unknown): ReportLevel {
  if (typeof value !== 'string') return 'off';
  const normalized = value.trim().toLowerCase();
  return normalized in PRIORITY ? (normalized as ReportLevel) : 'off';
}

export function reportLevel(source: ReportLevelSource): ReportLevel {
  return parseReportLevel(typeof source === 'string' ? source : source.OBSERVABILITY_REPORT_LEVEL);
}

export function shouldReport(level: LogLevel, source: ReportLevelSource): boolean {
  return PRIORITY[level] <= PRIORITY[reportLevel(source)];
}
