export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
  }, timeoutMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });

    if (!response.body) {
      clearTimeout(timeout);
      return response;
    }

    const reader = response.body.getReader();
    let released = false;

    const release = () => {
      if (released) return;

      released = true;
      clearTimeout(timeout);
      reader.releaseLock();
    };

    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const result = await reader.read();

          if (result.done) {
            release();
            streamController.close();
            return;
          }

          streamController.enqueue(result.value);
        } catch (error) {
          release();
          streamController.error(error);
        }
      },

      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}
