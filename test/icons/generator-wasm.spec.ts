import { afterEach, describe, expect, test, vi } from 'vitest';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>';

function mockResvg(initWasm: ReturnType<typeof vi.fn>) {
  vi.doMock('@resvg/resvg-wasm', () => ({
    initWasm,
    Resvg: class {},
  }));
}

describe('icon generator WASM initialization', () => {
  afterEach(() => {
    vi.doUnmock('@resvg/resvg-wasm');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test('reports a WASM initialization failure after fetching a valid SVG', async () => {
    const cause = new Error('WASM initialization failed');
    const initWasm = vi.fn(() => Promise.reject(cause));

    mockResvg(initWasm);

    const [{ getPngFromSvgIcon }, { IconError }] = await Promise.all([
      import('../../src/services/icons/generator'),
      import('../../src/services/icons/errors'),
    ]);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(svg, {
        headers: {
          'Content-Type': 'image/svg+xml',
        },
      }),
    );

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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(initWasm).toHaveBeenCalledTimes(1);

    expect(thrown).toBeInstanceOf(IconError);
    expect(thrown).toEqual(
      expect.objectContaining({
        code: 'WASM_INITIALIZATION_FAILED',
        message: 'The SVG renderer could not be initialized',
        stage: 'wasm',
        retryable: false,
        cause,
      }),
    );
  });

  test('does not initialize WASM when the SVG source fails', async () => {
    const initWasm = vi.fn(() => Promise.resolve());

    mockResvg(initWasm);

    const [{ getPngFromSvgIcon }, { IconError }] = await Promise.all([
      import('../../src/services/icons/generator'),
      import('../../src/services/icons/errors'),
    ]);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    let thrown: unknown;

    try {
      await getPngFromSvgIcon({
        iconType: 'lucide',
        iconName: 'missing',
        outputSize: 64,
      });
    } catch (error) {
      thrown = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(initWasm).not.toHaveBeenCalled();

    expect(thrown).toBeInstanceOf(IconError);
    expect(thrown).toEqual(
      expect.objectContaining({
        code: 'ICON_NOT_FOUND',
        stage: 'upstream',
        retryable: false,
        upstreamStatus: 404,
      }),
    );
  });

  test('does not initialize WASM when the fetched body is not valid SVG data', async () => {
    const initWasm = vi.fn(() => Promise.resolve());

    mockResvg(initWasm);

    const [{ getPngFromSvgIcon }, { IconError }] = await Promise.all([
      import('../../src/services/icons/generator'),
      import('../../src/services/icons/errors'),
    ]);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>not an icon</html>', {
        headers: {
          'Content-Type': 'text/plain',
        },
      }),
    );

    let thrown: unknown;

    try {
      await getPngFromSvgIcon({
        iconType: 'lucide',
        iconName: 'invalid',
        outputSize: 64,
      });
    } catch (error) {
      thrown = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(initWasm).not.toHaveBeenCalled();

    expect(thrown).toBeInstanceOf(IconError);
    expect(thrown).toEqual(
      expect.objectContaining({
        code: 'INVALID_SVG',
        stage: 'upstream',
        retryable: false,
      }),
    );
  });

  test('does not initialize WASM when the generator is imported without rendering', async () => {
    const initWasm = vi.fn(() => Promise.resolve());

    mockResvg(initWasm);

    await import('../../src/services/icons/generator');

    expect(initWasm).not.toHaveBeenCalled();
  });
});
