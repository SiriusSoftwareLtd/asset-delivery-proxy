import { describe, expect, test } from 'vitest';
import type { SvgIconConfig } from '../../src/services/icons/types';
import { validateOutputSize, validateSvgIconConfig } from '../../src/services/icons/validation';

describe('SVG icon validation', () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, 1025])('rejects invalid output size %s', (outputSize) => {
    expect(() => validateOutputSize(outputSize)).toThrow('size must be an integer');
  });

  test('rejects an invalid Remix category', () => {
    expect(() =>
      validateSvgIconConfig({
        iconType: 'remix',
        iconName: 'home',
        outputSize: 64,
        category: 'Not A Category',
      } as unknown as SvgIconConfig),
    ).toThrow('Invalid Remix icon category');
  });

  test('rejects an invalid Font Awesome style', () => {
    expect(() =>
      validateSvgIconConfig({
        iconType: 'font-awesome',
        iconName: 'circle',
        outputSize: 64,
        style: 'duotone',
      } as unknown as SvgIconConfig),
    ).toThrow('Invalid Font Awesome style');
  });

  test.each([
    ['16', 'outline'],
    ['20', 'outline'],
    ['32', 'solid'],
    ['24', 'invalid'],
  ])('rejects invalid Heroicons combination %s/%s', (sourceSize, style) => {
    expect(() =>
      validateSvgIconConfig({
        iconType: 'hero',
        iconName: 'academic-cap',
        outputSize: 64,
        sourceSize,
        style,
      } as unknown as SvgIconConfig),
    ).toThrow('Invalid Heroicons source size and style combination');
  });

  test('rejects an unknown SVG icon type defensively', () => {
    expect(() =>
      validateSvgIconConfig({
        iconType: 'unknown',
        iconName: 'check',
        outputSize: 64,
      } as unknown as SvgIconConfig),
    ).toThrow('Invalid icon type');
  });

  test.each([
    {
      iconType: 'lucide',
      iconName: 'check',
      outputSize: 64,
    },
    {
      iconType: 'feather',
      iconName: 'check',
      outputSize: 64,
    },
    {
      iconType: 'remix',
      iconName: 'home',
      outputSize: 64,
      category: 'System',
    },
    {
      iconType: 'font-awesome',
      iconName: 'circle',
      outputSize: 64,
      style: 'solid',
    },
    {
      iconType: 'hero',
      iconName: 'academic-cap',
      outputSize: 64,
      sourceSize: '24',
      style: 'outline',
    },
  ] satisfies SvgIconConfig[])('accepts valid config $iconType', (config) => {
    expect(() => validateSvgIconConfig(config)).not.toThrow();
  });
});
