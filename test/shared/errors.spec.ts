import { describe, expect, test } from 'vitest';
import { getErrorMessage, isTimeoutError } from '../../src/shared/errors';

describe('error utilities', () => {
  test('recognizes TimeoutError DOMExceptions', () => {
    expect(isTimeoutError(new DOMException('timed out', 'TimeoutError'))).toBe(true);
  });

  test('recognizes AbortError DOMExceptions', () => {
    expect(isTimeoutError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  test('rejects unrelated DOMExceptions and normal errors', () => {
    expect(isTimeoutError(new DOMException('invalid', 'InvalidStateError'))).toBe(false);

    expect(isTimeoutError(new Error('timed out'))).toBe(false);
    expect(isTimeoutError('TimeoutError')).toBe(false);
  });

  test('uses Error messages when available', () => {
    expect(getErrorMessage(new Error('failure'))).toBe('failure');
  });

  test.each([
    ['string', 'failure', 'failure'],
    ['number', 42, '42'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ])('stringifies non-Error %s values', (_label, value, expected) => {
    expect(getErrorMessage(value)).toBe(expected);
  });
});
