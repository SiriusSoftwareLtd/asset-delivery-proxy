import { describe, expect, test } from 'vitest';
import { readInteger } from '../../src/shared/config';

describe('readInteger', () => {
  test.each([
    ['valid value', '4', 1, 1, 32, 4],
    ['minimum value', '1', 7, 1, 32, 1],
    ['maximum value', '32', 7, 1, 32, 32],
    ['missing value', undefined, 7, 1, 32, 7],
    ['non-numeric value', 'invalid', 7, 1, 32, 7],
    ['fractional value', '1.5', 7, 1, 32, 7],
    ['below minimum', '0', 7, 1, 32, 7],
    ['above maximum', '33', 7, 1, 32, 7],
  ])('handles %s', (_label, value, fallback, minimum, maximum, expected) => {
    expect(readInteger(value, fallback, minimum, maximum)).toBe(expected);
  });
});
