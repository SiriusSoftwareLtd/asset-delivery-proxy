/** Returns whether an error was produced by an aborted or timed-out fetch. */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
