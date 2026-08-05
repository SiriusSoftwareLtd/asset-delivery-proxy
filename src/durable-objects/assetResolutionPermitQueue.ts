/*
 * Copyright (c) 2026 Corridon Capital
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type AssetResolutionPermit = { queueTimeMs: number };

export class AssetResolutionQueueFullError extends Error {
  constructor() {
    super('Queue full');
  }
}

export class AssetResolutionPermitDeadlineError extends Error {
  constructor() {
    super('Asset resolution deadline reached');
  }
}

type Waiter = {
  enqueuedAt: number;
  deadline: number;
  resolve: (permit: AssetResolutionPermit) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
};

export class AssetResolutionPermitQueue {
  private readonly waiters: Waiter[] = [];
  private active = 0;
  private nextPermitAt = 0;

  constructor(
    private readonly concurrency: number,
    private readonly queueLimit: number,
    private readonly permitIntervalMs: number,
    private readonly storage?: DurableObjectStorage,
  ) {}

  async restore(): Promise<void> {
    this.nextPermitAt = (await this.storage?.get<number>('nextPermitAt')) ?? 0;
  }

  get activeCount(): number {
    return this.active;
  }
  get queuedCount(): number {
    return this.waiters.length;
  }

  acquire(deadline: number): Promise<AssetResolutionPermit> {
    const now = Date.now();
    if (now >= deadline) return Promise.reject(new AssetResolutionPermitDeadlineError());
    this.expire(now);
    if (this.active < this.concurrency) return this.grant(now, deadline);
    if (this.waiters.length >= this.queueLimit) return Promise.reject(new AssetResolutionQueueFullError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        enqueuedAt: now,
        deadline,
        resolve,
        reject,
        timeout: setTimeout(() => this.expireWaiter(waiter), deadline - now),
        settled: false,
      };
      this.waiters.push(waiter);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.dispatch();
  }

  rejectQueued(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      this.settle(waiter);
      waiter.reject(error);
    }
  }

  private async grant(enqueuedAt: number, deadline: number): Promise<AssetResolutionPermit> {
    const scheduledAt = Math.max(Date.now(), this.nextPermitAt);
    if (scheduledAt >= deadline) throw new AssetResolutionPermitDeadlineError();
    this.active += 1;
    try {
      this.nextPermitAt = scheduledAt + this.permitIntervalMs;
      await this.storage?.put('nextPermitAt', this.nextPermitAt);
      if (scheduledAt > Date.now()) await new Promise<void>((resolve) => setTimeout(resolve, scheduledAt - Date.now()));
      if (Date.now() >= deadline) throw new AssetResolutionPermitDeadlineError();
      return { queueTimeMs: Math.max(0, Date.now() - enqueuedAt) };
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private dispatch(): void {
    this.expire();

    const waiter = this.waiters.shift();
    if (!waiter) return;

    this.settle(waiter);

    void this.grant(waiter.enqueuedAt, waiter.deadline).then(waiter.resolve, waiter.reject);
  }

  private expire(now = Date.now()): void {
    for (let index = 0; index < this.waiters.length; ) {
      const waiter = this.waiters[index];

      if (!waiter || waiter.deadline > now) {
        index += 1;
        continue;
      }

      this.waiters.splice(index, 1);
      this.settle(waiter);

      waiter.reject(new AssetResolutionPermitDeadlineError());
    }
  }

  private expireWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);

    if (index !== -1) {
      this.waiters.splice(index, 1);
    }

    if (this.settle(waiter)) {
      waiter.reject(new AssetResolutionPermitDeadlineError());
    }
  }

  private settle(waiter: Waiter): boolean {
    if (waiter.settled) return false;
    waiter.settled = true;
    clearTimeout(waiter.timeout);
    return true;
  }
}
