import { afterEach, describe, expect, test, vi } from 'vitest';

describe('icon generator WASM initialization', () => {
  afterEach(() => {
    vi.doUnmock('@resvg/resvg-wasm');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test('reports a WASM initialization failure', async () => {
    const cause = new Error('WASM initialization failed');

    let rejectWasm!: (reason?: unknown) => void;

    const wasmReady = new Promise<void>((_, reject) => {
      rejectWasm = reject;
    });

    vi.resetModules();

    vi.doMock('@resvg/resvg-wasm', async () => {
      const actual = await vi.importActual<typeof import('@resvg/resvg-wasm')>('@resvg/resvg-wasm');

      return {
        ...actual,
        initWasm: vi.fn(() => wasmReady),
      };
    });

    const [{ getPngFromSvgIcon }, { IconError }] = await Promise.all([
      import('../../src/services/icons/generator'),
      import('../../src/services/icons/errors'),
    ]);

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const request = getPngFromSvgIcon({
      iconType: 'lucide',
      iconName: 'check',
      outputSize: 64,
    });

    rejectWasm(cause);

    let thrown: unknown;

    try {
      await request;
    } catch (error) {
      thrown = error;
    }

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

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('does not initialize WASM when the generator is imported without rendering', async () => {
    const initWasm = vi.fn(() => Promise.resolve());

    vi.resetModules();
    vi.doMock('@resvg/resvg-wasm', async () => {
      const actual = await vi.importActual<typeof import('@resvg/resvg-wasm')>('@resvg/resvg-wasm');
      return { ...actual, initWasm };
    });

    await import('../../src/services/icons/generator');

    expect(initWasm).not.toHaveBeenCalled();
  });
});
