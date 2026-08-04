import { describe, expect, test } from 'vitest';
import { readBoundedBody } from '../../src/services/icons/body';

describe('readBoundedBody', () => {
  test('rejects a streamed body that exceeds the byte limit', async () => {
    const limit = 8;
    const tooLargeError = new Error('body too large');

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
        controller.enqueue(new Uint8Array([9]));
        controller.close();
      },
    });

    const response = new Response(stream);

    await expect(readBoundedBody(response, limit, () => tooLargeError)).rejects.toBe(tooLargeError);
  });

  test('returns a body that is exactly at the byte limit', async () => {
    const limit = 8;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
        controller.close();
      },
    });

    const response = new Response(stream);

    const body = await readBoundedBody(response, limit, () => new Error('body too large'));

    expect(body).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  });
});
