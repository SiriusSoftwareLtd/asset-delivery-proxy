import { env } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { parseReportLevel, shouldReport } from '../src/middleware/observability';
import worker from './worker';

function createEnv(reportLevel?: string): CloudflareBindings {
  return {
    ...env,
    ROBLOX_API_KEY: '',
    ENVIRONMENT: 'test',
    OBSERVABILITY_REPORT_LEVEL: reportLevel,
    assetCache: {
      async getWithMetadata() {
        return { value: null, metadata: null };
      },
      async put() {},
      async delete() {},
    },
    ASSET_PROXY_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
    FLAGS: {
      getBooleanValue: async () => false,
    },
  } as unknown as CloudflareBindings;
}

function request(assetId: string, headers: Record<string, string> = {}) {
  return new Request(`https://proxy.test/assets/${assetId}`, { headers });
}

describe('observability report levels', () => {
  test.each([
    [undefined, 'off'],
    [' invalid ', 'off'],
    [' WARN ', 'warn'],
  ])('parses %j as %s', (value, expected) => {
    expect(parseReportLevel(value)).toBe(expected);
  });

  test('warn reports warn and error but not info', () => {
    expect(shouldReport('error', 'warn')).toBe(true);
    expect(shouldReport('warn', 'warn')).toBe(true);
    expect(shouldReport('info', 'warn')).toBe(false);
  });

  test('info reports request completion and permits custom traces', () => {
    expect(shouldReport('info', 'info')).toBe(true);
    expect(shouldReport('debug', 'info')).toBe(false);
    expect(shouldReport('info', 'debug')).toBe(true);
  });

  test('default env emits no custom observability logs', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const response = await worker.fetch(request('101', { 'X-Rayfield-Secure-Mode': 'true' }), createEnv());

    expect(response.status).toBe(200);
    expect(info).not.toHaveBeenCalled();
    fetchMock.mockRestore();
    info.mockRestore();
  });

  test('info emits request.completed', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await worker.fetch(request('102', { 'X-Rayfield-Secure-Mode': 'true' }), createEnv('info'));

    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'request.completed' }));
    fetchMock.mockRestore();
    info.mockRestore();
  });

  test('warn emits warning events but suppresses request completion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const response = await worker.fetch(request('103'), createEnv('warn'));

    expect(response.status).toBe(403);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'asset.access.denied' }));
    expect(info).not.toHaveBeenCalled();
    warn.mockRestore();
    info.mockRestore();
  });

  test('error emits request.failed for a handled route failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await worker.fetch(request('not-an-id'), createEnv('error'));

    expect(response.status).toBe(400);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'request.failed' }));
    error.mockRestore();
  });
});
