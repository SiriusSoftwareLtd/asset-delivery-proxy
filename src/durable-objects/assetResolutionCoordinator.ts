/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { DurableObject } from 'cloudflare:workers';
import { readKv, writeAssetToKv, writeNotFoundToKv } from '../assets/cache';
import { resolveAssetExtension } from '../assets/extension';
import type {
  AssetCacheWriteOutcome,
  AssetCoordinatorRequest,
  AssetResolutionOrigin,
  AssetResolutionResult,
} from '../assets/types';
import { fetchRobloxAsset, isRetryableUpstreamStatus, parseRetryAfter } from '../assets/upstream/roblox';
import { cancelResponseBody } from '../infrastructure/http/cancelResponseBody';
import {
  AssetResolutionPermitDeadlineError,
  AssetResolutionPermitQueue,
  AssetResolutionQueueFullError,
} from './assetResolutionPermitQueue';

const COOLDOWN_KEY = 'cooldownUntil';

export type Permit = { queueTimeMs: number };

class QueueFullError extends Error {}
class CooldownError extends Error {
  constructor(readonly retryAfter: number) {
    super('Roblox asset delivery is cooling down');
  }
}
class PermitDeadlineError extends Error {}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sleepWithinDeadline(milliseconds: number, deadline: number): Promise<boolean> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return false;
  await sleep(Math.min(milliseconds, remainingMs));
  return Date.now() < deadline;
}

function jitter(milliseconds: number): number {
  const random = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
  return Math.floor(milliseconds * (0.5 + random / 255));
}

function originForAttempts(attempts: number): AssetResolutionOrigin {
  return attempts === 0 ? 'admission' : 'upstream';
}

export class AssetResolutionCoordinator extends DurableObject<CloudflareBindings> {
  private readonly inFlight = new Map<string, Promise<AssetResolutionResult>>();
  private readonly permitIntervalMs: number;
  private readonly fallbackCooldownSeconds: number;
  private readonly retryBaseMs: number;
  private readonly permitQueue: AssetResolutionPermitQueue;
  private cooldownUntil = 0;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    const concurrency = readInteger(env.ASSET_COORDINATOR_CONCURRENCY, 1, 1, 32);
    const queueLimit = readInteger(env.ASSET_COORDINATOR_QUEUE_LIMIT, 32, 0, 1_000);
    this.permitIntervalMs = readInteger(env.ASSET_COORDINATOR_PERMIT_INTERVAL_MS, 1_000, 0, 60_000);
    this.fallbackCooldownSeconds = readInteger(env.ASSET_COORDINATOR_FALLBACK_COOLDOWN_SECONDS, 30, 1, 3_600);
    this.retryBaseMs = readInteger(env.ASSET_COORDINATOR_RETRY_BASE_MS, 250, 1, 10_000);
    this.permitQueue = new AssetResolutionPermitQueue(concurrency, queueLimit, this.permitIntervalMs, ctx.storage);

    ctx.blockConcurrencyWhile(async () => {
      this.cooldownUntil = (await this.ctx.storage.get<number>(COOLDOWN_KEY)) ?? 0;
      await this.permitQueue.restore();
    });
  }

  async resolve(request: AssetCoordinatorRequest): Promise<AssetResolutionResult> {
    const existing = this.inFlight.get(request.identity.canonicalKey);
    if (existing) {
      return { ...(await existing), joined: true };
    }

    const operation = this.resolveUncoalesced(request);
    this.inFlight.set(request.identity.canonicalKey, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(request.identity.canonicalKey) === operation) {
        this.inFlight.delete(request.identity.canonicalKey);
      }
    }
  }

  private async resolveUncoalesced(request: AssetCoordinatorRequest): Promise<AssetResolutionResult> {
    const cached = await readKv(this.env.assetCache, request.identity);
    if (cached.kind === 'asset' && cached.entry.state === 'fresh') {
      return {
        kind: 'asset',
        status: 200,
        data: cached.entry.data,
        contentType: cached.entry.metadata.contentType,
        extension: cached.entry.metadata.extension,
        timestamp: cached.entry.metadata.timestamp,
        attempts: 0,
        queueTimeMs: 0,
        joined: false,
        origin: 'kv',
        cacheWrite: 'not-attempted',
      };
    }
    if (cached.kind === 'not-found') {
      return {
        kind: 'not-found',
        status: 404,
        error: 'Asset not found',
        timestamp: cached.timestamp,
        attempts: 0,
        queueTimeMs: 0,
        joined: false,
        origin: 'kv',
        cacheWrite: 'not-attempted',
      };
    }

    let queueTimeMs = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (Date.now() >= request.deadline) {
        const attempts = attempt - 1;
        return this.errorResult(
          504,
          'Roblox asset delivery timed out',
          attempts,
          queueTimeMs,
          originForAttempts(attempts),
        );
      }

      let permit: Permit = { queueTimeMs: 0 };
      let permitHeld = false;
      if (request.backpressure) {
        try {
          permit = await this.acquirePermit(request.deadline);
          permitHeld = true;
        } catch (error) {
          const attempts = attempt - 1;
          if (error instanceof PermitDeadlineError) {
            return this.errorResult(
              504,
              'Roblox asset delivery timed out',
              attempts,
              queueTimeMs,
              originForAttempts(attempts),
            );
          }
          if (error instanceof CooldownError) {
            return this.errorResult(
              429,
              error.message,
              attempts,
              queueTimeMs,
              originForAttempts(attempts),
              error.retryAfter,
            );
          }
          return this.errorResult(
            503,
            'Asset resolution queue is full',
            attempts,
            queueTimeMs,
            originForAttempts(attempts),
            Math.max(1, Math.ceil(this.permitIntervalMs / 1_000)),
          );
        }
      }
      queueTimeMs += permit.queueTimeMs;

      try {
        if (Date.now() >= request.deadline) {
          const attempts = attempt - 1;
          return this.errorResult(
            504,
            'Roblox asset delivery timed out',
            attempts,
            queueTimeMs,
            originForAttempts(attempts),
          );
        }
        const resolution = await fetchRobloxAsset(
          request.identity.protocol,
          request.identity.upstreamUrl,
          request.identity.upstreamHeaders,
          this.env.ROBLOX_API_KEY,
          request.deadline,
        );

        if (resolution.kind === 'rejection') {
          if (
            request.backpressure &&
            resolution.retryable &&
            attempt === 1 &&
            Date.now() + this.retryBaseMs < request.deadline
          ) {
            this.releasePermit();
            permitHeld = false;
            if (!(await sleepWithinDeadline(jitter(this.retryBaseMs), request.deadline))) {
              return this.errorResult(504, 'Roblox asset delivery timed out', attempt, queueTimeMs, 'upstream');
            }
            continue;
          }
          return this.errorResult(
            resolution.status,
            resolution.error,
            attempt,
            queueTimeMs,
            'upstream',
            undefined,
            resolution.upstreamStatus,
          );
        }
        try {
          const response = resolution.response;
          const upstreamStatus = response.status;
          const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
          if (!response.ok) {
            if (upstreamStatus === 404) {
              const timestamp = Date.now();
              await cancelResponseBody(response);
              let cacheWrite: AssetCacheWriteOutcome = 'written';
              try {
                await writeNotFoundToKv(this.env.assetCache, request.identity, timestamp);
              } catch {
                cacheWrite = 'failed';
              }
              return {
                kind: 'not-found',
                status: 404,
                error: 'Asset not found',
                timestamp,
                upstreamStatus,
                attempts: attempt,
                queueTimeMs,
                joined: false,
                origin: 'upstream',
                cacheWrite,
              };
            }

            if (upstreamStatus === 429) {
              const retryAfter = parseRetryAfter(response.headers.get('Retry-After')) ?? this.fallbackCooldownSeconds;
              if (request.backpressure) await this.enterCooldown(retryAfter);
              await cancelResponseBody(response);
              return this.errorResult(
                429,
                response.statusText || 'Too Many Requests',
                attempt,
                queueTimeMs,
                'upstream',
                retryAfter,
                429,
              );
            }

            if (
              request.backpressure &&
              isRetryableUpstreamStatus(upstreamStatus) &&
              attempt === 1 &&
              Date.now() < request.deadline
            ) {
              await cancelResponseBody(response);
              this.releasePermit();
              permitHeld = false;
              if (!(await sleepWithinDeadline(jitter(this.retryBaseMs), request.deadline))) {
                return this.errorResult(504, 'Roblox asset delivery timed out', attempt, queueTimeMs, 'upstream');
              }
              continue;
            }

            return {
              kind: 'error',
              status: upstreamStatus,
              error: response.statusText || 'Roblox asset delivery failed',
              data: new Uint8Array(await response.arrayBuffer()),
              contentType,
              upstreamStatus,
              attempts: attempt,
              queueTimeMs,
              joined: false,
              origin: 'upstream',
              cacheWrite: 'not-attempted',
            };
          }

          const resolved = await resolveAssetExtension(contentType, response.body, resolution.assetTypeId);
          const data = new Uint8Array(await new Response(resolved.body).arrayBuffer());
          if (data.byteLength === 0) {
            return this.errorResult(
              502,
              'Roblox returned an empty asset',
              attempt,
              queueTimeMs,
              'upstream',
              undefined,
              upstreamStatus,
            );
          }
          const timestamp = Date.now();
          let cacheWrite: AssetCacheWriteOutcome = 'written';
          try {
            await writeAssetToKv(
              this.env.assetCache,
              request.identity,
              data,
              contentType,
              resolved.extension,
              timestamp,
            );
          } catch {
            cacheWrite = 'failed';
          }
          return {
            kind: 'asset',
            status: 200,
            data,
            contentType,
            extension: resolved.extension,
            timestamp,
            upstreamStatus,
            attempts: attempt,
            queueTimeMs,
            joined: false,
            origin: 'upstream',
            cacheWrite,
          };
        } finally {
          await resolution.cleanup();
        }
      } finally {
        if (permitHeld) this.releasePermit();
      }
    }

    return this.errorResult(502, 'Unable to reach Roblox asset delivery', 2, queueTimeMs, 'upstream');
  }

  private errorResult(
    status: number,
    error: string,
    attempts: number,
    queueTimeMs: number,
    origin: AssetResolutionOrigin,
    retryAfter?: number,
    upstreamStatus?: number,
  ): AssetResolutionResult {
    return {
      kind: 'error',
      status,
      origin,
      error,
      retryAfter,
      upstreamStatus,
      attempts,
      queueTimeMs,
      joined: false,
      cacheWrite: 'not-attempted',
    };
  }

  private acquirePermit(deadline: number): Promise<Permit> {
    const now = Date.now();
    if (now >= deadline) return Promise.reject(new PermitDeadlineError('Asset resolution deadline reached'));
    if (this.cooldownUntil > now) {
      return Promise.reject(new CooldownError(Math.max(1, Math.ceil((this.cooldownUntil - now) / 1_000))));
    }
    return this.permitQueue.acquire(deadline).catch((error) => {
      if (error instanceof AssetResolutionPermitDeadlineError) throw new PermitDeadlineError(error.message);
      if (error instanceof AssetResolutionQueueFullError) throw new QueueFullError(error.message);
      throw error;
    });
  }

  private releasePermit(): void {
    this.permitQueue.release();
  }

  private async enterCooldown(retryAfter: number): Promise<void> {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryAfter * 1_000);
    await this.ctx.storage.put(COOLDOWN_KEY, this.cooldownUntil);
    this.permitQueue.rejectQueued(new CooldownError(retryAfter));
  }
}
