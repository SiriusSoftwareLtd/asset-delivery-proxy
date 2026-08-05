/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { tracing } from 'cloudflare:workers';
import { type ReportLevelSource, reportLevel } from './reportLevel';

export type TraceSpan = {
  setAttribute(name: string, value?: boolean | number | string): void;
};

export type TraceRuntime = {
  enterSpan?<T>(name: string, callback: (span: TraceSpan) => T | Promise<T>): T | Promise<T>;
};

const noopSpan = { setAttribute() {} } satisfies TraceSpan;

export function enterTraceSpanWithRuntime<T>(
  runtime: TraceRuntime | undefined,
  name: string,
  callback: (span: TraceSpan) => T | Promise<T>,
  source: ReportLevelSource,
): T | Promise<T> {
  if (!['info', 'debug'].includes(reportLevel(source)) || !runtime?.enterSpan) {
    return callback(noopSpan);
  }

  return runtime.enterSpan(name, callback);
}

export function enterTraceSpan<T>(
  name: string,
  callback: (span: TraceSpan) => T | Promise<T>,
  source: ReportLevelSource,
): T | Promise<T> {
  return enterTraceSpanWithRuntime(tracing, name, callback, source);
}
