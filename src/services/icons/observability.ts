/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

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
