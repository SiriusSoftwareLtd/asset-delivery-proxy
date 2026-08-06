/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Context } from 'hono';
import type { BlankInput } from 'hono/types';
import type { AssetPolicy } from '../assets/policy';
import type { CacheStatus } from '../assets/types';

export type AppEnvironment = {
  Bindings: CloudflareBindings;
  Variables: {
    requestId: string;
    cacheStatus: CacheStatus;
    upstreamStatus?: number;
    assetMissLimit?: Promise<boolean>;
    assetLazyLimitEnabled: boolean;
    '.rateLimit'?: boolean;
    assetPolicy?: AssetPolicy;
  };
};

export type AppContext = Context<AppEnvironment, string, BlankInput>;
