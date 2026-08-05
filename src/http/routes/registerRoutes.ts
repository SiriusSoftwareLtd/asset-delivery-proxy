/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Hono } from 'hono';
import type { AppEnvironment } from '../context';
import { handleAssetBatchRequest, handleAssetDelivery } from './assets';
import { handleIconBatchRequest, handleIconRequest } from './icons';

export function registerRoutes(): Hono<AppEnvironment> {
  const api = new Hono<AppEnvironment>().basePath('/v1');
  api.post('/assets/batch', handleAssetBatchRequest);
  api.get('/assets/:assetId', handleAssetDelivery);
  api.get('/icons/:iconPack/:iconName', handleIconRequest);
  api.post('/icons/batch', handleIconBatchRequest);
  return api;
}
