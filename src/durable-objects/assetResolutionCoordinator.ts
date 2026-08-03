import { DurableObject } from 'cloudflare:workers';
import { readKv, writeAssetToKv, writeNotFoundToKv } from '../services/assets/cache';
import { resolveAssetExtension } from '../services/assets/extension';
import { fetchRobloxAsset, isRetryableUpstreamStatus, parseRetryAfter } from '../services/assets/roblox';
import type { AssetCoordinatorRequest, AssetResolutionResult } from '../types/app';

const COOLDOWN_KEY = 'cooldownUntil';
const NEXT_PERMIT_KEY = 'nextPermitAt';

type Permit = { queueTimeMs: number };
type PermitWaiter = {
  enqueuedAt: number;
  resolve: (permit: Permit) => void;
  reject: (error: Error) => void;
};

class QueueFullError extends Error {}
class CooldownError extends Error {
  constructor(readonly retryAfter: number) {
    super('Roblox asset delivery is cooling down');
  }
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function jitter(milliseconds: number): number {
  const random = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
  return Math.floor(milliseconds * (0.5 + random / 255));
}

export class AssetResolutionCoordinator extends DurableObject<CloudflareBindings> {
  private readonly inFlight = new Map<string, Promise<AssetResolutionResult>>();
  private readonly queue: PermitWaiter[] = [];
  private readonly concurrency: number;
  private readonly queueLimit: number;
  private readonly permitIntervalMs: number;
  private readonly fallbackCooldownSeconds: number;
  private readonly retryBaseMs: number;
  private active = 0;
  private cooldownUntil = 0;
  private nextPermitAt = 0;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.concurrency = readInteger(env.ASSET_COORDINATOR_CONCURRENCY, 1, 1, 32);
    this.queueLimit = readInteger(env.ASSET_COORDINATOR_QUEUE_LIMIT, 32, 0, 1_000);
    this.permitIntervalMs = readInteger(env.ASSET_COORDINATOR_PERMIT_INTERVAL_MS, 1_000, 0, 60_000);
    this.fallbackCooldownSeconds = readInteger(env.ASSET_COORDINATOR_FALLBACK_COOLDOWN_SECONDS, 30, 1, 3_600);
    this.retryBaseMs = readInteger(env.ASSET_COORDINATOR_RETRY_BASE_MS, 250, 1, 10_000);

    ctx.blockConcurrencyWhile(async () => {
      const [cooldownUntil, nextPermitAt] = await Promise.all([
        this.ctx.storage.get<number>(COOLDOWN_KEY),
        this.ctx.storage.get<number>(NEXT_PERMIT_KEY),
      ]);
      this.cooldownUntil = cooldownUntil ?? 0;
      this.nextPermitAt = nextPermitAt ?? 0;
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
    const cached = await readKv(this.env.assetCache, request.identity, {
      allowLegacy: Date.now() < Date.parse(this.env.ASSET_LEGACY_V1_READ_UNTIL),
    });
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
      };
    }

    let queueTimeMs = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (Date.now() >= request.deadline) {
        return this.errorResult(504, 'Roblox asset delivery timed out', attempt - 1, queueTimeMs);
      }

      let permit: Permit = { queueTimeMs: 0 };
      let permitHeld = false;
      if (request.backpressure) {
        try {
          permit = await this.acquirePermit();
          permitHeld = true;
        } catch (error) {
          if (error instanceof CooldownError) {
            return this.errorResult(429, error.message, attempt - 1, queueTimeMs, error.retryAfter);
          }
          return this.errorResult(
            503,
            'Asset resolution queue is full',
            attempt - 1,
            queueTimeMs,
            Math.max(1, Math.ceil(this.permitIntervalMs / 1_000)),
          );
        }
      }
      queueTimeMs += permit.queueTimeMs;

      try {
        if (Date.now() >= request.deadline) {
          return this.errorResult(504, 'Roblox asset delivery timed out', attempt - 1, queueTimeMs);
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
            await sleep(jitter(this.retryBaseMs));
            continue;
          }
          return this.errorResult(
            resolution.status,
            resolution.error,
            attempt,
            queueTimeMs,
            undefined,
            resolution.upstreamStatus,
          );
        }

        const response = resolution.response;
        const upstreamStatus = response.status;
        const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
        if (!response.ok) {
          if (upstreamStatus === 404) {
            const timestamp = Date.now();
            await response.body?.cancel().catch(() => undefined);
            await writeNotFoundToKv(this.env.assetCache, request.identity, timestamp).catch(() => undefined);
            return {
              kind: 'not-found',
              status: 404,
              error: 'Asset not found',
              timestamp,
              upstreamStatus,
              attempts: attempt,
              queueTimeMs,
              joined: false,
            };
          }

          if (upstreamStatus === 429) {
            const retryAfter = parseRetryAfter(response.headers.get('Retry-After')) ?? this.fallbackCooldownSeconds;
            if (request.backpressure) await this.enterCooldown(retryAfter);
            await response.body?.cancel().catch(() => undefined);
            return this.errorResult(
              429,
              response.statusText || 'Too Many Requests',
              attempt,
              queueTimeMs,
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
            await response.body?.cancel().catch(() => undefined);
            this.releasePermit();
            permitHeld = false;
            await sleep(jitter(this.retryBaseMs));
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
            undefined,
            upstreamStatus,
          );
        }
        const timestamp = Date.now();
        await writeAssetToKv(
          this.env.assetCache,
          request.identity,
          data,
          contentType,
          resolved.extension,
          timestamp,
        ).catch(() => undefined);
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
        };
      } finally {
        if (permitHeld) this.releasePermit();
      }
    }

    return this.errorResult(502, 'Unable to reach Roblox asset delivery', 2, queueTimeMs);
  }

  private errorResult(
    status: number,
    error: string,
    attempts: number,
    queueTimeMs: number,
    retryAfter?: number,
    upstreamStatus?: number,
  ): AssetResolutionResult {
    return {
      kind: 'error',
      status,
      error,
      retryAfter,
      upstreamStatus,
      attempts,
      queueTimeMs,
      joined: false,
    };
  }

  private acquirePermit(): Promise<Permit> {
    const now = Date.now();
    if (this.cooldownUntil > now) {
      return Promise.reject(new CooldownError(Math.max(1, Math.ceil((this.cooldownUntil - now) / 1_000))));
    }
    if (this.active < this.concurrency) {
      return this.grantPermit(now);
    }
    if (this.queue.length >= this.queueLimit) return Promise.reject(new QueueFullError('Queue full'));

    return new Promise((resolve, reject) => {
      this.queue.push({ enqueuedAt: now, resolve, reject });
    });
  }

  private async grantPermit(enqueuedAt: number): Promise<Permit> {
    this.active += 1;
    const scheduledAt = Math.max(Date.now(), this.nextPermitAt);
    this.nextPermitAt = scheduledAt + this.permitIntervalMs;
    await this.ctx.storage.put(NEXT_PERMIT_KEY, this.nextPermitAt);
    if (scheduledAt > Date.now()) await sleep(scheduledAt - Date.now());

    const now = Date.now();
    if (this.cooldownUntil > now) {
      this.releasePermit();
      throw new CooldownError(Math.max(1, Math.ceil((this.cooldownUntil - now) / 1_000)));
    }
    return { queueTimeMs: Math.max(0, now - enqueuedAt) };
  }

  private releasePermit(): void {
    this.active = Math.max(0, this.active - 1);
    const waiter = this.queue.shift();
    if (!waiter) return;
    void this.grantPermit(waiter.enqueuedAt).then(waiter.resolve, waiter.reject);
  }

  private async enterCooldown(retryAfter: number): Promise<void> {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryAfter * 1_000);
    await this.ctx.storage.put(COOLDOWN_KEY, this.cooldownUntil);
    const error = new CooldownError(retryAfter);
    for (const waiter of this.queue.splice(0)) waiter.reject(error);
  }
}
