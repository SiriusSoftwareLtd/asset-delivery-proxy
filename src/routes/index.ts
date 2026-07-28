import type { Hono } from 'hono';
import type { AppEnvironment } from '../types/app';
import { handleAssetBatchRequest, handleAssetDelivery } from './assetDelivery';
import { handleIconBatchRequest, handleIconRequest } from './icons';

export function registerRoutes(app: Hono<AppEnvironment>) {
  app.post('/assets/batch', handleAssetBatchRequest);
  app.get('/assets/:assetId', handleAssetDelivery);
  app.get('/icons/:iconPack/:iconName', handleIconRequest);
  app.post('/icon/batch', handleIconBatchRequest);
}
