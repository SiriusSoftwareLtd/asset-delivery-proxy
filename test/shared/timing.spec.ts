import { describe, expect, test, vi } from 'vitest';
import { sleepWithinDeadline } from '../../src/shared/timing';

describe('sleepWithinDeadline', () => {
  test('returns false when the deadline has already passed', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      await expect(sleepWithinDeadline(250, 1_000)).resolves.toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('returns true when sleep completes before the deadline', async () => {
    vi.useFakeTimers();

    try {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100);

      const result = sleepWithinDeadline(100, 2_000);

      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toBe(true);

      nowSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  test('returns false when the deadline expires during sleep', async () => {
    vi.useFakeTimers();

    try {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);

      const result = sleepWithinDeadline(1_000, 2_000);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(false);

      nowSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
