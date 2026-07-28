import { initWasm, Resvg, type ResvgRenderOptions } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { enterTraceSpan, type LogLevel, parseReportLevel, shouldReport } from './observability';

/*
 * Initialize once per Worker isolate. Individual requests await the same promise,
 * avoiding repeated Wasm initialization.
 */
const wasmReady = initWasm(resvgWasm);

const REMIX_ICON_CATEGORIES = [
  'Arrows',
  'Buildings',
  'Business',
  'Communication',
  'Design',
  'Development',
  'Device',
  'Document',
  'Editor',
  'Finance',
  'Games & Sports',
  'Health & Medical',
  'Logos',
  'Map',
  'Media',
  'Others',
  'System',
  'User & Faces',
  'Weather',
] as const;

type RemixIconCategory = (typeof REMIX_ICON_CATEGORIES)[number];
type FontAwesomeStyle = 'brands' | 'regular' | 'solid';

type BaseIconConfig = {
  iconName: string;
  outputSize: number;
};

export type IconConfig = BaseIconConfig &
  (
    | {
        iconType: 'lucide' | 'feather';
      }
    | {
        iconType: 'remix';
        category: RemixIconCategory;
      }
    | {
        iconType: 'font-awesome';
        style: FontAwesomeStyle;
      }
    | {
        iconType: 'hero';
        sourceSize: '16' | '20';
        style: 'solid';
      }
    | {
        iconType: 'hero';
        sourceSize: '24';
        style: 'outline' | 'solid';
      }
  );

type IconStage = 'validation' | 'wasm' | 'upstream' | 'render';

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

type IconLogger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

export type IconOperationContext = {
  /**
   * A request or correlation ID from the API handler.
   * Keep this in logs rather than trace attributes to avoid high cardinality.
   */
  requestId?: string;

  /**
   * Allows tests to inject a logger or disable logs with a no-op logger.
   */
  logger?: IconLogger;

  /** Successful conversions are opt-in because icons can be requested frequently. */
  logSuccess?: boolean;

  /** Controls icon logs and custom trace spans. Defaults to off. */
  reportLevel?: string;
};

const MAX_SVG_BYTES = 512 * 1024;
const MAX_OUTPUT_SIZE = 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const SVG_PREFIX_BYTES = 8 * 1024;

const ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const REMIX_CATEGORY_SET = new Set<string>(REMIX_ICON_CATEGORIES);
const FONT_AWESOME_STYLES = new Set(['brands', 'regular', 'solid']);

function logEvent(
  logger: IconLogger,
  level: LogLevel,
  event: string,
  fields: Record<string, unknown>,
  reportLevel: string,
): void {
  if (!shouldReport(level, parseReportLevel(reportLevel))) return;

  // Workers Logs preserves console objects, making these fields searchable.
  logger[level]({
    event,
    ...fields,
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function validateIconConfig(iconConfig: IconConfig): void {
  /*
   * TypeScript types disappear at runtime, so API input still needs explicit
   * validation before being used to construct an upstream URL.
   */
  if (
    typeof iconConfig.outputSize !== 'number' ||
    !Number.isInteger(iconConfig.outputSize) ||
    iconConfig.outputSize < 1 ||
    iconConfig.outputSize > MAX_OUTPUT_SIZE
  ) {
    throw new IconError('INVALID_OUTPUT_SIZE', `outputSize must be an integer between 1 and ${MAX_OUTPUT_SIZE}`, {
      stage: 'validation',
      retryable: false,
    });
  }

  if (typeof iconConfig.iconName !== 'string' || !ICON_NAME_PATTERN.test(iconConfig.iconName)) {
    throw new IconError(
      'INVALID_ICON_NAME',
      'iconName must contain only lowercase letters, numbers, hyphens, and underscores',
      {
        stage: 'validation',
        retryable: false,
      },
    );
  }

  switch (iconConfig.iconType) {
    case 'lucide':
    case 'feather':
      return;

    case 'remix':
      if (!REMIX_CATEGORY_SET.has(iconConfig.category)) {
        throw new IconError('INVALID_CONFIG', 'Invalid Remix icon category', {
          stage: 'validation',
          retryable: false,
        });
      }
      return;

    case 'font-awesome':
      if (!FONT_AWESOME_STYLES.has(iconConfig.style)) {
        throw new IconError('INVALID_CONFIG', 'Invalid Font Awesome style', {
          stage: 'validation',
          retryable: false,
        });
      }
      return;

    case 'hero':
      if (
        !['16', '20', '24'].includes(iconConfig.sourceSize) ||
        !['solid', 'outline'].includes(iconConfig.style) ||
        (iconConfig.sourceSize !== '24' && iconConfig.style !== 'solid')
      ) {
        throw new IconError('INVALID_CONFIG', 'Invalid Heroicons source size and style combination', {
          stage: 'validation',
          retryable: false,
        });
      }
      return;

    default:
      throw new IconError('INVALID_CONFIG', 'Unsupported icon provider', {
        stage: 'validation',
        retryable: false,
      });
  }
}

function rawGitHubUrl(owner: string, repository: string, ref: string, ...pathSegments: string[]): string {
  const encodedPath = pathSegments.map(encodeURIComponent).join('/');

  return `https://raw.githubusercontent.com/${owner}/${repository}/${encodeURIComponent(ref)}/${encodedPath}`;
}

function getLucideSvgIconUrl(iconName: string): string {
  return rawGitHubUrl('lucide-icons', 'lucide', 'main', 'icons', `${iconName}.svg`);
}

function getRemixIconUrl(category: RemixIconCategory, iconName: string): string {
  return rawGitHubUrl('Remix-Design', 'RemixIcon', 'master', 'icons', category, `${iconName}.svg`);
}

function getFeatherIconUrl(iconName: string): string {
  return rawGitHubUrl('feathericons', 'feather', 'main', 'icons', `${iconName}.svg`);
}

function getHeroIconUrl(sourceSize: '16' | '20' | '24', style: 'outline' | 'solid', iconName: string): string {
  return rawGitHubUrl('tailwindlabs', 'heroicons', 'master', 'optimized', sourceSize, style, `${iconName}.svg`);
}

function getFontAwesomeIconUrl(style: FontAwesomeStyle, iconName: string): string {
  return rawGitHubUrl('FortAwesome', 'Font-Awesome', '7.x', 'svgs', style, `${iconName}.svg`);
}

function getIconUrl(iconConfig: IconConfig): string {
  switch (iconConfig.iconType) {
    case 'lucide':
      return getLucideSvgIconUrl(iconConfig.iconName);

    case 'remix':
      return getRemixIconUrl(iconConfig.category, iconConfig.iconName);

    case 'feather':
      return getFeatherIconUrl(iconConfig.iconName);

    case 'hero':
      return getHeroIconUrl(iconConfig.sourceSize, iconConfig.style, iconConfig.iconName);

    case 'font-awesome':
      return getFontAwesomeIconUrl(iconConfig.style, iconConfig.iconName);
  }
}

/**
 * Reads an upstream response incrementally so a missing or dishonest
 * Content-Length header cannot force the Worker to buffer an unbounded body.
 */
async function readSvgBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new IconError('EMPTY_SVG', 'The upstream response did not contain a body', {
      stage: 'upstream',
      retryable: true,
    });
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      totalBytes += result.value.byteLength;

      if (totalBytes > MAX_SVG_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size error is more useful than a cancellation error.
        }

        throw new IconError('SVG_TOO_LARGE', `SVG exceeds the ${MAX_SVG_BYTES}-byte limit`, {
          stage: 'upstream',
          retryable: false,
        });
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw new IconError('EMPTY_SVG', 'The upstream response contained an empty SVG', {
      stage: 'upstream',
      retryable: false,
    });
  }

  const content = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return content;
}

async function getIconContent(iconConfig: IconConfig, reportLevel: string): Promise<Uint8Array> {
  return enterTraceSpan(
    'icon.fetch',
    async (span) => {
      span.setAttribute('icon.provider', iconConfig.iconType);

      const url = getIconUrl(iconConfig);

      try {
        const response = await fetch(url, {
          headers: {
            Accept: 'image/svg+xml',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        span.setAttribute('http.status_code', response.status);

        if (response.status === 404) {
          throw new IconError('ICON_NOT_FOUND', 'The requested icon does not exist', {
            stage: 'upstream',
            retryable: false,
            upstreamStatus: response.status,
          });
        }

        if (!response.ok) {
          throw new IconError('UPSTREAM_HTTP_ERROR', `Icon source returned HTTP ${response.status}`, {
            stage: 'upstream',
            retryable: response.status === 429 || response.status >= 500,
            upstreamStatus: response.status,
          });
        }

        const declaredLength = response.headers.get('content-length');

        if (declaredLength !== null) {
          const declaredBytes = Number(declaredLength);

          if (Number.isFinite(declaredBytes) && declaredBytes > MAX_SVG_BYTES) {
            throw new IconError('SVG_TOO_LARGE', `SVG exceeds the ${MAX_SVG_BYTES}-byte limit`, {
              stage: 'upstream',
              retryable: false,
            });
          }
        }

        const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();

        /*
         * Raw GitHub normally returns image/svg+xml, but text/plain and
         * application/octet-stream are accepted for compatibility.
         */
        if (contentType && !['image/svg+xml', 'text/plain', 'application/octet-stream'].includes(contentType)) {
          throw new IconError('INVALID_CONTENT_TYPE', `Icon source returned ${contentType}`, {
            stage: 'upstream',
            retryable: false,
          });
        }

        const content = await readSvgBody(response);
        const prefix = new TextDecoder().decode(content.subarray(0, Math.min(content.byteLength, SVG_PREFIX_BYTES)));

        // Reject obvious non-SVG responses before invoking the renderer.
        if (!/<svg(?:\s|>)/i.test(prefix)) {
          throw new IconError('INVALID_SVG', 'The upstream response does not appear to contain SVG data', {
            stage: 'upstream',
            retryable: false,
          });
        }

        span.setAttribute('svg.bytes', content.byteLength);

        return content;
      } catch (error) {
        if (error instanceof IconError) {
          throw error;
        }

        if (isTimeoutError(error)) {
          throw new IconError('UPSTREAM_TIMEOUT', `Icon source did not respond within ${UPSTREAM_TIMEOUT_MS}ms`, {
            stage: 'upstream',
            retryable: true,
            cause: error,
          });
        }

        throw new IconError('UPSTREAM_FETCH_FAILED', 'Failed to fetch the icon source', {
          stage: 'upstream',
          retryable: true,
          cause: error,
        });
      }
    },
    reportLevel,
  );
}

function createRenderConfig(outputSize: number, providedConfig: ResvgRenderOptions = {}): ResvgRenderOptions {
  const providedFont = providedConfig.font;

  /*
   * System fonts are unavailable or nondeterministic in edge runtimes.
   * Explicit font buffers are retained when the caller provides them.
   */
  const font =
    providedFont && 'fontBuffers' in providedFont
      ? providedFont
      : {
          ...(providedFont ?? {}),
          loadSystemFonts: false,
        };

  return {
    ...providedConfig,
    dpi: providedConfig.dpi ?? 96,
    shapeRendering: providedConfig.shapeRendering ?? 2,
    imageRendering: providedConfig.imageRendering ?? 0,
    background: providedConfig.background ?? 'rgba(0, 0, 0, 0)',

    /*
     * Keep outputSize authoritative. Do not allow arbitrary API input to
     * override this object through providedConfig.
     */
    fitTo: {
      mode: 'width',
      value: outputSize,
    },
    font,
  };
}

async function ensureWasmReady(): Promise<void> {
  try {
    await wasmReady;
  } catch (error) {
    throw new IconError('WASM_INITIALIZATION_FAILED', 'The SVG renderer could not be initialized', {
      stage: 'wasm',
      retryable: false,
      cause: error,
    });
  }
}

function renderPng(svgContent: Uint8Array, renderConfig: ResvgRenderOptions, reportLevel: string): Uint8Array {
  return enterTraceSpan(
    'icon.render',
    (span) => {
      try {
        const resvg = new Resvg(svgContent, renderConfig);

        try {
          const rendered = resvg.render();

          try {
            // Copy the Wasm-backed bytes before freeing the image.
            const png = new Uint8Array(rendered.asPng());

            if (png.byteLength === 0) {
              throw new Error('Renderer returned an empty PNG');
            }

            span.setAttribute('png.bytes', png.byteLength);
            return png;
          } finally {
            rendered.free();
          }
        } finally {
          resvg.free();
        }
      } catch (error) {
        if (error instanceof IconError) {
          throw error;
        }

        throw new IconError('RENDER_FAILED', 'Failed to render the SVG as PNG', {
          stage: 'render',
          retryable: false,
          cause: error,
        });
      }
    },
    reportLevel,
  ) as Uint8Array;
}

/**
 * Fetches an SVG icon from a supported provider and renders it as PNG data.
 *
 * The icon configuration is validated before the source SVG is fetched.
 * SVG downloads and rendered output sizes are bounded to protect Worker
 * resources. WebAssembly-backed rendering resources are released before the
 * returned PNG bytes leave this function.
 *
 * @param iconConfig - Identifies the icon provider, icon, source variant, and
 * desired output width.
 * @param providedConfig - Additional trusted resvg rendering options. The
 * `fitTo` option is overridden so that `iconConfig.outputSize` remains
 * authoritative.
 * @param context - Optional request-scoped logging and observability settings.
 *
 * @returns A promise resolving to a copied `Uint8Array` containing the encoded
 * PNG file.
 *
 * @throws {IconError} With `stage: "validation"` when the icon configuration
 * or output size is invalid.
 * @throws {IconError} With `stage: "wasm"` when the renderer cannot initialize.
 * @throws {IconError} With `stage: "upstream"` when the SVG cannot be fetched
 * or fails size, content-type, or content validation.
 * @throws {IconError} With `stage: "render"` when resvg cannot render the SVG.
 *
 * @example
 * ```ts
 * const png = await getPngFromSvgIcon(
 *   {
 *     iconType: 'lucide',
 *     iconName: 'circle-check',
 *     outputSize: 256,
 *   },
 *   {},
 *   {
 *     requestId: request.headers.get('cf-ray') ?? undefined,
 *   },
 * );
 *
 * return new Response(png, {
 *   headers: {
 *     'Content-Type': 'image/png',
 *   },
 * });
 * ```
 */
export async function getPngFromSvgIcon(
  iconConfig: IconConfig,
  providedConfig: ResvgRenderOptions = {},
  context: IconOperationContext = {},
): Promise<Uint8Array> {
  const logger = context.logger ?? console;
  const reportLevel = parseReportLevel(context.reportLevel);

  try {
    validateIconConfig(iconConfig);

    return await enterTraceSpan(
      'icon.generate',
      async (span) => {
        /*
         * Provider and size have small, bounded value sets. iconName and
         * requestId are intentionally excluded to limit trace cardinality.
         */
        span.setAttribute('icon.provider', iconConfig.iconType);
        span.setAttribute('icon.output_size', iconConfig.outputSize);

        await ensureWasmReady();

        const svgContent = await getIconContent(iconConfig, reportLevel);
        const renderConfig = createRenderConfig(iconConfig.outputSize, providedConfig);
        const png = renderPng(svgContent, renderConfig, reportLevel);

        if (context.logSuccess) {
          logEvent(
            logger,
            'info',
            'icon.generate.succeeded',
            {
              requestId: context.requestId,
              provider: iconConfig.iconType,
              iconName: iconConfig.iconName,
              outputSize: iconConfig.outputSize,
              svgBytes: svgContent.byteLength,
              pngBytes: png.byteLength,
            },
            reportLevel,
          );
        }

        return png;
      },
      reportLevel,
    );
  } catch (error) {
    const operationalError =
      error instanceof IconError
        ? error
        : new IconError('UNEXPECTED_ERROR', 'An unexpected icon-generation error occurred', {
            stage: 'render',
            retryable: false,
            cause: error,
          });

    logEvent(
      logger,
      'error',
      'icon.generate.failed',
      {
        requestId: context.requestId,
        provider: iconConfig.iconType,
        iconName: iconConfig.iconName,
        outputSize: iconConfig.outputSize,
        errorCode: operationalError.code,
        errorStage: operationalError.stage,
        retryable: operationalError.retryable,
        upstreamStatus: operationalError.upstreamStatus,
        message: operationalError.message,
        cause: getErrorMessage(operationalError.cause),
        stack: operationalError.stack,
      },
      reportLevel,
    );

    throw operationalError;
  }
}
