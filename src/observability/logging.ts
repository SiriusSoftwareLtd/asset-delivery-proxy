/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type LogLevel, type ReportLevelSource, shouldReport } from './reportLevel';

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown>,
  source: ReportLevelSource,
): void {
  if (shouldReport(level, source)) console[level]({ event, ...fields });
}

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
