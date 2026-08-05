/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/* istanbul ignore file -- the local workerd test runtime does not expose enterSpan. */
import { tracing } from 'cloudflare:workers';
import { type ReportLevelSource, reportLevel } from './reportLevel';

type TraceSpan = { setAttribute(name: string, value?: boolean | number | string): void };
const noopSpan = { setAttribute() {} } satisfies TraceSpan;

export function enterTraceSpan<T>(
  name: string,
  callback: (span: TraceSpan) => T | Promise<T>,
  source: ReportLevelSource,
): T | Promise<T> {
  if (!['info', 'debug'].includes(reportLevel(source)) || !tracing?.enterSpan) return callback(noopSpan);
  // Local workerd builds used by the test pool do not expose this branch.
  /* istanbul ignore next */
  return tracing.enterSpan(name, callback);
}
