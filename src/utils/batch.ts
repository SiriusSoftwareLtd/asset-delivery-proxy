const BASE64_CHUNK_SIZE = 0x8000;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  callback: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index]);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export function bytesToBase64(data: Uint8Array<ArrayBuffer>): string {
  let binary = '';

  for (let offset = 0; offset < data.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...data.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }

  return btoa(binary);
}
