export type TimedFetchResponse = {
  response: Response;
  cleanup: () => Promise<void>;
};

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<TimedFetchResponse> {
  const controller = new AbortController();
  let cleanedUp = false;
  let response: Response | undefined;

  const timeout = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
  }, timeoutMs);

  const cleanup = async () => {
    if (cleanedUp) return;

    cleanedUp = true;

    try {
      if (response?.body && !response.bodyUsed && !response.body.locked) {
        await response.body.cancel();
      }
    } catch {
      // Cleanup errors should not replace the request result.
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });

    return {
      response,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
