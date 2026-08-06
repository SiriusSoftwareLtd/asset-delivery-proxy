/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { AppContext } from '../http/context';
import { getErrorFields, logEvent } from '../observability/logging';

export type AssetPolicy = {
  cacheHitExemptLimit: () => Promise<boolean>;
  useDeliveryV2: () => Promise<boolean>;
  layeredCache: () => Promise<boolean>;
  upstreamCoordinator: () => Promise<boolean>;
  upstreamBackpressure: () => Promise<boolean>;
};

const POLICY_CONTEXT_KEY = 'assetPolicy';

async function evaluateFlag(c: AppContext, name: string, fallback = false): Promise<boolean> {
  try {
    return await c.env.FLAGS.getBooleanValue(name, fallback, {
      environment: c.env.ENVIRONMENT,
    });
  } catch (error) {
    logEvent(
      'warn',
      'asset.flag.evaluation_failed',
      { requestId: c.get('requestId'), flag: name, ...getErrorFields(error) },
      c.env,
    );
    return fallback;
  }
}

export function getAssetPolicy(c: AppContext): AssetPolicy {
  const existing = c.get(POLICY_CONTEXT_KEY);
  if (existing) return existing;

  const memoized = new Map<string, Promise<boolean>>();
  const flag = (name: string): Promise<boolean> => {
    const existingValue = memoized.get(name);
    if (existingValue) return existingValue;
    const value = evaluateFlag(c, name);
    memoized.set(name, value);
    return value;
  };

  const policy: AssetPolicy = {
    cacheHitExemptLimit: () => flag('asset-cache-hit-exempt-limit'),
    useDeliveryV2: () => flag('use-asset-delivery-v2'),
    layeredCache: () => flag('asset-cache-layered'),
    upstreamCoordinator: () => flag('asset-upstream-coordinator'),
    upstreamBackpressure: () => flag('asset-upstream-backpressure'),
  };
  if (typeof c.set === 'function') c.set(POLICY_CONTEXT_KEY, policy);
  return policy;
}
