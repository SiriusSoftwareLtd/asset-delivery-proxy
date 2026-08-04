export type TimedFetchResponse = {
  response: Response;
  cleanup: () => void;
};

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<TimedFetchResponse> {
  const controller = new AbortController();
  let cleanedUp = false;

  const timeout = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
  }, timeoutMs);

  const cleanup = () => {
    if (cleanedUp) return;

    cleanedUp = true;
    clearTimeout(timeout);
  };

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });

    return {
      response,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
