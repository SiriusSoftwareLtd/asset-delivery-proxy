export type IconStage = 'validation' | 'wasm' | 'upstream' | 'render';

export type IconErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_ICON_NAME'
  | 'INVALID_OUTPUT_SIZE'
  | 'WASM_INITIALIZATION_FAILED'
  | 'ICON_NOT_FOUND'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_FETCH_FAILED'
  | 'UPSTREAM_HTTP_ERROR'
  | 'INVALID_CONTENT_TYPE'
  | 'EMPTY_SVG'
  | 'SVG_TOO_LARGE'
  | 'INVALID_SVG'
  | 'RENDER_FAILED'
  | 'UNEXPECTED_ERROR';

type IconErrorDetails = {
  stage: IconStage;
  retryable: boolean;
  upstreamStatus?: number;
  cause?: unknown;
};

/**
 * A stable operational error that the HTTP layer can safely translate into
 * status codes without inspecting error messages.
 */
export class IconError extends Error {
  readonly code: IconErrorCode;
  readonly stage: IconStage;
  readonly retryable: boolean;
  readonly upstreamStatus?: number;

  constructor(code: IconErrorCode, message: string, details: IconErrorDetails) {
    super(message, { cause: details.cause });

    this.name = 'IconError';
    this.code = code;
    this.stage = details.stage;
    this.retryable = details.retryable;
    this.upstreamStatus = details.upstreamStatus;
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
