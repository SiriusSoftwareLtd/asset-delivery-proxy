import { describe, expect, test } from 'vitest';
import { parseIconConfig } from '../../src/services/icons/config';
import { IconError } from '../../src/services/icons/errors';

describe('icon configuration parsing', () => {
  test('normalizes the default SVG output size', () => {
    const result = parseIconConfig('lucide', 'check', new URLSearchParams());

    expect(result).toEqual({
      config: {
        iconType: 'lucide',
        iconName: 'check',
        outputSize: 64,
      },
      normalizedOptions: 'size=64',
      cacheIdentity: 'check',
    });
  });

  test('rejects an invalid Remix category', () => {
    expect(() =>
      parseIconConfig(
        'remix',
        'home',
        new URLSearchParams({
          category: 'Invalid',
        }),
      ),
    ).toThrow('Invalid Remix icon category');
  });

  test('rejects an invalid Font Awesome style', () => {
    expect(() =>
      parseIconConfig(
        'font-awesome',
        'circle',
        new URLSearchParams({
          style: 'duotone',
        }),
      ),
    ).toThrow('Invalid Font Awesome style');
  });

  test('rejects an invalid Heroicons source size', () => {
    expect(() =>
      parseIconConfig(
        'hero',
        'academic-cap',
        new URLSearchParams({
          sourceSize: '32',
          style: 'solid',
        }),
      ),
    ).toThrow('Invalid Heroicons sourceSize');
  });

  test('rejects an invalid Heroicons style', () => {
    expect(() =>
      parseIconConfig(
        'hero',
        'academic-cap',
        new URLSearchParams({
          sourceSize: '24',
          style: 'duotone',
        }),
      ),
    ).toThrow('Invalid Heroicons style');
  });

  test('rejects outline style for Heroicons 16 and 20', () => {
    let thrown: unknown;

    try {
      parseIconConfig(
        'hero',
        'academic-cap',
        new URLSearchParams({
          sourceSize: '20',
          style: 'outline',
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IconError);
    expect(thrown).toEqual(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        stage: 'validation',
        retryable: false,
      }),
    );
  });

  test('accepts solid Heroicons at source size 16', () => {
    const result = parseIconConfig(
      'hero',
      'academic-cap',
      new URLSearchParams({
        sourceSize: '16',
        style: 'solid',
        size: '128',
      }),
    );

    expect(result.config).toEqual({
      iconType: 'hero',
      iconName: 'academic-cap',
      outputSize: 128,
      sourceSize: '16',
      style: 'solid',
    });
  });

  test('rejects a non-integer output size string', () => {
    expect(() =>
      parseIconConfig(
        'lucide',
        'check',
        new URLSearchParams({
          size: '64px',
        }),
      ),
    ).toThrow('size must be an integer');
  });

  test('defaults Font Awesome icons to solid style', () => {
    const result = parseIconConfig('font-awesome', 'circle', new URLSearchParams());

    expect(result).toEqual({
      config: {
        iconType: 'font-awesome',
        iconName: 'circle',
        outputSize: 64,
        style: 'solid',
      },
      normalizedOptions: 'size=64',
      cacheIdentity: 'circle',
    });
  });

  test('defaults Heroicons to 24px outline icons', () => {
    const result = parseIconConfig('hero', 'academic-cap', new URLSearchParams());

    expect(result).toEqual({
      config: {
        iconType: 'hero',
        iconName: 'academic-cap',
        outputSize: 64,
        sourceSize: '24',
        style: 'outline',
      },
      normalizedOptions: 'size=64',
      cacheIdentity: 'academic-cap',
    });
  });

  test('rejects an unknown icon pack', () => {
    let thrown: unknown;

    try {
      parseIconConfig('unknown-pack', 'check', new URLSearchParams());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IconError);
    expect(thrown).toEqual(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message: 'unknown icon pack unknown-pack',
        stage: 'validation',
        retryable: false,
      }),
    );
  });
});
