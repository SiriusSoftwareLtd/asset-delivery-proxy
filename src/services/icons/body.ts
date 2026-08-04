export async function readBoundedBody(
  response: Response,
  maxBytes: number,
  tooLargeError: () => Error,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();

  if (!reader) {
    return new Uint8Array(new ArrayBuffer(0));
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) break;

      totalBytes += result.value.byteLength;

      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Keep the size error.
        }

        throw tooLargeError();
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(new ArrayBuffer(totalBytes));
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}
