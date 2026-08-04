import { initWasm, Resvg, type ResvgRenderOptions } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { enterTraceSpan, parseReportLevel } from '../../middleware/observability';
import { getErrorMessage, isTimeoutError } from '../../utils/errors';
import { fetchWithTimeout } from '../../utils/fetch';
import { readBoundedBody } from './body';
import { MAX_SVG_BYTES, SVG_PREFIX_BYTES, UPSTREAM_TIMEOUT_MS } from './constants';
import { IconError } from './errors';
import { logIconEvent } from './observability';
import { getSvgIconUrl } from './sources';
import type { IconOperationContext, SvgIconConfig } from './types';
import { validateSvgIconConfig } from './validation';

/*
 * Initialize once per Worker isolate. Individual requests await the same promise,
 * avoiding repeated Wasm initialization.
 */
const wasmReady = initWasm(resvgWasm);

/**
 * Reads an upstream response incrementally so a missing or dishonest
 * Content-Length header cannot force the Worker to buffer an unbounded body.
 */
async function readSvgBody(response: Response): Promise<Uint8Array> {
  const content = await readBoundedBody(response, MAX_SVG_BYTES, () => {
    return new IconError('SVG_TOO_LARGE', `SVG exceeds the ${MAX_SVG_BYTES}-byte limit`, {
      stage: 'upstream',
      retryable: false,
    });
  });

  if (content.byteLength === 0) {
    throw new IconError('EMPTY_SVG', 'The upstream response contained an empty SVG', {
      stage: 'upstream',
      retryable: false,
    });
  }

  return content;
}

async function getSvgIconContent(iconConfig: SvgIconConfig, reportLevel: string): Promise<Uint8Array> {
  return enterTraceSpan(
    'icon.fetch',
    async (span) => {
      span.setAttribute('icon.provider', iconConfig.iconType);

      const url = getSvgIconUrl(iconConfig);

      try {
        const upstream = await fetchWithTimeout(
          url,
          {
            headers: {
              Accept: 'image/svg+xml',
            },
            redirect: 'manual',
          },
          UPSTREAM_TIMEOUT_MS,
        );
        const response = upstream.response;

        try {
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
        } finally {
          await upstream.cleanup();
        }
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
  iconConfig: SvgIconConfig,
  providedConfig: ResvgRenderOptions = {},
  context: IconOperationContext = {},
): Promise<Uint8Array> {
  const logger = context.logger ?? console;
  const reportLevel = parseReportLevel(context.reportLevel);

  try {
    validateSvgIconConfig(iconConfig);

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

        const svgContent = await getSvgIconContent(iconConfig, reportLevel);
        const renderConfig = createRenderConfig(iconConfig.outputSize, providedConfig);
        const png = renderPng(svgContent, renderConfig, reportLevel);

        if (context.logSuccess) {
          logIconEvent(
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

    logIconEvent(
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
