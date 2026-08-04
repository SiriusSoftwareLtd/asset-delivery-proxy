import { describe, expect, test, vi } from 'vitest';
import { IconError } from '../../src/services/icons/errors';
import { getPngFromSvgIcon } from '../../src/services/icons/generator';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>';

describe('icon generator', () => {
  test('emits the opt-in success event after rendering', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(svg, {
        headers: { 'Content-Type': 'image/svg+xml' },
      }),
    );

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    try {
      const png = await getPngFromSvgIcon(
        {
          iconType: 'lucide',
          iconName: 'check',
          outputSize: 64,
        },
        {},
        {
          logger,
          requestId: 'request-1',
          logSuccess: true,
          reportLevel: 'info',
        },
      );

      expect(png.byteLength).toBeGreaterThan(0);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'icon.generate.succeeded',
          requestId: 'request-1',
          provider: 'lucide',
          iconName: 'check',
          outputSize: 64,
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('wraps malformed renderable SVG input as a render failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<svg><', {
        headers: { 'Content-Type': 'image/svg+xml' },
      }),
    );

    try {
      let thrown: unknown;

      try {
        await getPngFromSvgIcon({
          iconType: 'lucide',
          iconName: 'check',
          outputSize: 64,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(IconError);
      expect(thrown).toEqual(
        expect.objectContaining({
          code: 'RENDER_FAILED',
          stage: 'render',
          retryable: false,
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
