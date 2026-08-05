import type { ResvgRenderOptions } from '@resvg/resvg-wasm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  renderConfigs: [] as ResvgRenderOptions[],
  validateSvgIconConfig: vi.fn(),
}));

vi.mock('@resvg/resvg-wasm', () => {
  class MockResvg {
    constructor(_svg: Uint8Array, config: ResvgRenderOptions) {
      mocks.renderConfigs.push(config);
    }

    render() {
      return {
        asPng: () => new Uint8Array([1, 2, 3]),
        free: vi.fn(),
      };
    }

    free() {}
  }

  return {
    initWasm: vi.fn(async () => {}),
    Resvg: MockResvg,
  };
});

vi.mock('../../src/services/icons/validation', () => ({
  validateSvgIconConfig: mocks.validateSvgIconConfig,
}));

import { IconError } from '../../src/services/icons/errors';
import { getPngFromSvgIcon } from '../../src/services/icons/generator';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>';

const iconConfig = {
  iconType: 'lucide',
  iconName: 'check',
  outputSize: 64,
} as const;

describe('icon generator render configuration', () => {
  beforeEach(() => {
    mocks.renderConfigs.length = 0;
    mocks.validateSvgIconConfig.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('preserves explicit font buffers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(svg, {
        headers: {
          'Content-Type': 'image/svg+xml',
        },
      }),
    );

    const font = {
      fontBuffers: [],
    } as NonNullable<ResvgRenderOptions['font']>;

    await getPngFromSvgIcon(
      iconConfig,
      {
        font,
      },
      {
        reportLevel: 'off',
      },
    );

    expect(mocks.renderConfigs).toHaveLength(1);
    expect(mocks.renderConfigs[0]?.font).toBe(font);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('disables system fonts when font options do not contain buffers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(svg, {
        headers: {
          'Content-Type': 'image/svg+xml',
        },
      }),
    );

    const font = {
      loadSystemFonts: true,
    } as NonNullable<ResvgRenderOptions['font']>;

    await getPngFromSvgIcon(
      iconConfig,
      {
        font,
      },
      {
        reportLevel: 'off',
      },
    );

    expect(mocks.renderConfigs).toHaveLength(1);

    expect(mocks.renderConfigs[0]?.font).toEqual({
      loadSystemFonts: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('normalizes an unexpected non-IconError failure', async () => {
    const cause = new Error('unexpected validation failure');

    mocks.validateSvgIconConfig.mockImplementationOnce(() => {
      throw cause;
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    let thrown: unknown;

    try {
      await getPngFromSvgIcon(
        iconConfig,
        {},
        {
          reportLevel: 'off',
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IconError);

    expect(thrown).toEqual(
      expect.objectContaining({
        code: 'UNEXPECTED_ERROR',
        message: 'An unexpected icon-generation error occurred',
        stage: 'render',
        retryable: false,
        cause,
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
