import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AppContext } from '../../src/http/context';

const mocks = vi.hoisted(() => ({
  parseIconConfig: vi.fn(),
  getPngFromSvgIcon: vi.fn(),
}));

vi.mock('../../src/services/icons/config', () => ({
  parseIconConfig: mocks.parseIconConfig,
}));

vi.mock('../../src/services/icons/generator', () => ({
  getPngFromSvgIcon: mocks.getPngFromSvgIcon,
}));

import { fetchIcon } from '../../src/icons/delivery';

function createContext(): AppContext {
  const cache = {
    getWithMetadata: async () => ({
      value: null,
      metadata: null,
    }),
    put: async () => {},
  } as unknown as KVNamespace;

  return {
    env: {
      ...env,
      assetCache: cache,
      OBSERVABILITY_REPORT_LEVEL: 'off',
    },
    get: (key: string) => {
      if (key === 'requestId') {
        return 'test-request-id';
      }

      return undefined;
    },
    set: vi.fn(),
  } as unknown as AppContext;
}

describe('icon delivery error boundaries', () => {
  afterEach(() => {
    mocks.parseIconConfig.mockReset();
    mocks.getPngFromSvgIcon.mockReset();
  });

  test.each([
    {
      name: 'an Error',
      failure: new Error('unexpected config failure'),
      expectedError: 'unexpected config failure',
    },
    {
      name: 'a non-Error value',
      failure: 'invalid config',
      expectedError: 'Invalid config request',
    },
  ])('normalizes $name thrown during config parsing', async ({ failure, expectedError }) => {
    mocks.parseIconConfig.mockImplementation(() => {
      throw failure;
    });

    const result = await fetchIcon('lucide', 'check', new URLSearchParams(), createContext());

    expect(result).toEqual({
      iconPack: 'lucide',
      iconName: 'check',
      kind: 'error',
      status: 400,
      error: expectedError,
    });

    expect(mocks.getPngFromSvgIcon).not.toHaveBeenCalled();
  });

  test('normalizes an unexpected renderer error', async () => {
    mocks.parseIconConfig.mockReturnValue({
      config: {
        iconType: 'lucide',
        iconName: 'check',
        outputSize: 64,
      },
      normalizedOptions: 'size=64',
      cacheIdentity: 'check',
    });

    mocks.getPngFromSvgIcon.mockRejectedValue(new Error('unexpected renderer failure'));

    const result = await fetchIcon('lucide', 'check', new URLSearchParams(), createContext());

    expect(result).toEqual({
      iconPack: 'lucide',
      iconName: 'check',
      kind: 'error',
      status: 502,
      error: 'Unable to generate icon',
    });

    expect(mocks.getPngFromSvgIcon).toHaveBeenCalledTimes(1);
  });
});
