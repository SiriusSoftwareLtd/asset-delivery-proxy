import { env } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import worker from './worker';

function createTestEnv(options: { rateLimit?: () => Promise<{ success: boolean }> } = {}): CloudflareBindings {
  return {
    ...env,
    ASSET_PROXY_RATE_LIMITER: {
      limit: options.rateLimit ?? (async () => ({ success: true })),
    },
  } as unknown as CloudflareBindings;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://proxy.test${path}`, init);
}

describe('worker', () => {
  test('health endpoint returns OK', async () => {
    const response = await worker.fetch(request('/health'), createTestEnv());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
  });

  test('root redirects to the Rayfield Gen 2 documentation', async () => {
    const response = await worker.fetch(request('/'), createTestEnv());

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://docs.sirius.menu/rayfield-gen2');
  });

  test('unknown routes return 404', async () => {
    const response = await worker.fetch(request('/not-a-real-route'), createTestEnv());

    expect(response.status).toBe(404);

    const body = (await response.json()) as {
      error: string;
      requestId?: string;
    };

    expect(body.error).toBe('Not found');
  });

  test('global rate limiting can reject a request', async () => {
    const response = await worker.fetch(
      request('/health'),
      createTestEnv({
        rateLimit: async () => ({ success: false }),
      }),
    );

    expect(response.status).toBe(429);
  });

  test('falls back to global limiting when lazy asset-limit flag evaluation fails', async () => {
    const limiter = vi.fn(async () => ({ success: false }));

    const getBooleanValue = vi.fn(async (name: string, fallback = false) => {
      if (name === 'asset-cache-hit-exempt-limit') {
        throw new Error('Flag service unavailable');
      }

      return fallback;
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const testEnv = {
      ...createTestEnv({
        rateLimit: limiter,
      }),
      FLAGS: {
        getBooleanValue,
      },
      OBSERVABILITY_REPORT_LEVEL: 'warn',
    } as unknown as CloudflareBindings;

    try {
      const response = await worker.fetch(
        request('/assets/123', {
          headers: {
            'X-Rayfield-Secure-Mode': 'true',
          },
        }),
        testEnv,
      );

      expect(response.status).toBe(429);
      expect(limiter).toHaveBeenCalledTimes(1);

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'asset.flag.evaluation_failed',
          flag: 'asset-cache-hit-exempt-limit',
          errorMessage: 'Flag service unavailable',
        }),
      );

      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'request.failed',
          method: 'GET',
          path: '/assets/123',
          status: 429,
        }),
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test('returns 500 when the global rate limiter binding throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const testEnv = {
      ...createTestEnv({
        rateLimit: async () => {
          throw new Error('rate limiter unavailable');
        },
      }),
      OBSERVABILITY_REPORT_LEVEL: 'error',
    } as unknown as CloudflareBindings;

    try {
      const response = await worker.fetch(request('/health'), testEnv);

      expect(response.status).toBe(500);

      const body = await response.json<{
        error: string;
        requestId?: string;
      }>();

      expect(body.error).toBe('Internal server error');

      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'request.failed',
          method: 'GET',
          path: '/health',
          status: 500,
          errorName: 'Error',
          errorMessage: 'rate limiter unavailable',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
