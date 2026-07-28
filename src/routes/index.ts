import type { Hono } from 'hono';
import type { AppEnvironment } from '../types';
import { handleAssetDelivery } from './assetDelivery';
import { handleIconRequest } from './icons';

export function registerRoutes(app: Hono<AppEnvironment>) {
  app.get('/assets/:assetId', handleAssetDelivery);
  app.get('/icons/:iconPack/:iconName', handleIconRequest);
}
