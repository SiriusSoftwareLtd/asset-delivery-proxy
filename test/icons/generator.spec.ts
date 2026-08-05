import { describe, expect, test, vi } from 'vitest';
import { MAX_SVG_BYTES } from '../../src/services/icons/constants';
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
  test('rejects an oversized streamed SVG without Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_SVG_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, {
        headers: {
          'Content-Type': 'image/svg+xml',
        },
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
          code: 'SVG_TOO_LARGE',
          stage: 'upstream',
          retryable: false,
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('marks upstream 429 responses as retryable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 429 }));

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
          code: 'UPSTREAM_HTTP_ERROR',
          stage: 'upstream',
          retryable: true,
          upstreamStatus: 429,
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('marks upstream 4xx responses other than 429 as non-retryable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 400 }));

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
          code: 'UPSTREAM_HTTP_ERROR',
          stage: 'upstream',
          retryable: false,
          upstreamStatus: 400,
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('ignores a non-numeric upstream Content-Length', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(svg, {
        headers: {
          'Content-Type': 'image/svg+xml',
          'Content-Length': 'unknown',
        },
      }),
    );

    try {
      const png = await getPngFromSvgIcon({
        iconType: 'lucide',
        iconName: 'check',
        outputSize: 64,
      });

      expect(png.byteLength).toBeGreaterThan(0);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('rejects a successful response that does not contain SVG data', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>not an icon</html>', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
        },
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
          code: 'INVALID_SVG',
          stage: 'upstream',
          retryable: false,
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
