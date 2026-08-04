/**
 * Checks whether an error was caused by a timed-out or aborted operation.
 *
 * @param error - The error value to check.
 * @returns Whether the error is a timeout or abort DOMException.
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Returns a readable message for an unknown error value.
 *
 * Uses the message from Error instances and converts all other values
 * to their string representation.
 *
 * @param error - The error value to convert.
 * @returns A human-readable error message.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
