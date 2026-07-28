import { tracing } from 'cloudflare:workers';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { rateLimit } from './rateLimiter';
import {
	buildRobloxV1Url,
	buildRobloxV2Request,
	MalformedRobloxV2ResponseError,
	parseRobloxV2Discovery,
} from './robloxAssetDelivery';
import {
	resolveAssetExtension,
} from './assetExtension';

type CacheStatus =
	| 'unknown'
	| 'bypass'
	| 'hit'
	| 'miss'
	| 'negative-hit'
	| 'negative-write'
	| 'read-error'
	| 'corrupt'
	| 'write-error';

type AppEnvironment = {
	Bindings: CloudflareBindings;
	Variables: {
		requestId: string;
		cacheStatus: CacheStatus;
		upstreamStatus?: number;
	};
};

type LogLevel = 'info' | 'warn' | 'error';

type CachedAssetMetadata =
	| {
			kind: 'asset';
			timestamp: number;
			contentType: string;
			extension?: string;
	  }
	| {
			kind: 'not-found';
			timestamp: number;
	  };

const ROBLOX_TIMEOUT_MS = 10_000;
const ASSET_ID_PATTERN = /^\d{1,20}$/;
const NEGATIVE_CACHE_TTL_SECONDS = 5 * 60;
const ASSET_EXTENSION_HEADER = 'X-Asset-Extension';

type TraceSpan = {
	setAttribute(name: string, value: unknown): void;
};

function enterTraceSpan<T>(
	name: string,
	callback: (span: TraceSpan) => Promise<T>,
): Promise<T> {
	const tracingApi = tracing as unknown as {
		enterSpan?: (
			spanName: string,
			spanCallback: (span: TraceSpan) => Promise<T>,
		) => Promise<T>;
	} | undefined;

	return tracingApi?.enterSpan
		? tracingApi.enterSpan(name, callback)
		: callback({ setAttribute() {} });
}

const app = new Hono<AppEnvironment>();

/**
 * Writes a structured event to Cloudflare Workers Logs.
 *
 * Fields such as `event`, `requestId`, and `assetId` can be used when querying
 * logs. Request IP addresses are intentionally excluded.
 */
function logEvent(
	level: LogLevel,
	event: string,
	fields: Record<string, unknown>,
): void {
	console[level]({
		event,
		...fields,
	});
}

/**
 * Converts an unknown error into safe structured log fields.
 */
function getErrorFields(
	error: unknown,
): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			errorName: error.name,
			errorMessage: error.message,
			errorStack: error.stack,
			errorCause:
				error.cause instanceof Error
					? error.cause.message
					: error.cause,
		};
	}

	return {
		errorMessage: String(error),
	};
}

/**
 * Returns whether an error was produced by an aborted or timed-out fetch.
 */
function isTimeoutError(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === 'TimeoutError' ||
			error.name === 'AbortError')
	);
}

/**
 * Adds request correlation and emits one structured access log after each
 * successfully handled request.
 */
const observeRequests =
	createMiddleware<AppEnvironment>(async (c, next) => {
		const requestId =
			c.req.header('CF-Ray') ?? crypto.randomUUID();
		const startedAt = performance.now();

		c.set('requestId', requestId);
		c.set('cacheStatus', 'unknown');
		c.header('X-Request-ID', requestId);

		await next();

		logEvent('info', 'request.completed', {
			requestId,
			method: c.req.method,
			path: c.req.path,
			status: c.res.status,
			cacheStatus: c.get('cacheStatus'),
			upstreamStatus: c.get('upstreamStatus'),
			durationMs: Number(
				(performance.now() - startedAt).toFixed(2),
			),
		});
	});

app.use('*', observeRequests);

app.use('*', async (c, next) => {
	const rateLimiter = rateLimit(
		c.env.ASSET_PROXY_RATE_LIMITER,
		(context) =>
			context.req.header('CF-Connecting-IP') ??
			context.req.header('X-Forwarded-For') ??
			'anonymous',
	);

	return rateLimiter(c, next);
});

app.get('/assets/:assetId', async (c) => {
	return enterTraceSpan(
		'asset.delivery',
		async (span) => {
			const requestId = c.get('requestId');
			const assetId = c.req.param('assetId');
			const isSecureMode =
				c.req.header(
					'X-Rayfield-Secure-Mode',
				) === 'true';
			const assetCache = c.env.assetCache;

			/*
			 * assetId is intentionally excluded from trace attributes because
			 * it has high cardinality. It remains available in structured logs.
			 */
			span.setAttribute(
				'asset.secure_mode',
				isSecureMode,
			);

			if (!ASSET_ID_PATTERN.test(assetId)) {
				throw new HTTPException(400, {
					message: 'Invalid Roblox asset ID',
				});
			}

			if (!isSecureMode) {
				c.set('cacheStatus', 'bypass');
				span.setAttribute(
					'cache.status',
					'bypass',
				);

				logEvent('warn', 'asset.access.denied', {
					requestId,
					assetId,
					reason: 'secure-mode-required',
				});

				return c.json(
					{
						error: 'Secure mode is required',
						requestId,
					},
					403,
				);
			}

			let cachedValue: ArrayBuffer | null = null;
			let cachedMetadata:
				| CachedAssetMetadata
				| null = null;
			let assetExtension: string | undefined;
			let assetTypeId: number | undefined;
			let useAssetDeliveryV2 = false;
			try {
				useAssetDeliveryV2 =
					await c.env.FLAGS.getBooleanValue(
						'use-asset-delivery-v2',
						false,
					);
			} catch (error) {
				logEvent('warn', 'asset.flag.evaluation_failed', {
					requestId,
					assetId,
					flag: 'use-asset-delivery-v2',
					...getErrorFields(error),
				});
			}

			const v2Request = useAssetDeliveryV2
				? buildRobloxV2Request(assetId, c.req.raw)
				: null;
			const cacheKey = v2Request?.cacheKey ?? assetId;

			try {
				/*
				 * KV automatically records this operation as a child of the
				 * asset.delivery span.
				 */
				const cached =
					await assetCache.getWithMetadata<CachedAssetMetadata>(
						cacheKey,
						'arrayBuffer',
					);

				cachedValue = cached.value;
				cachedMetadata = cached.metadata;
			} catch (error) {
				c.set('cacheStatus', 'read-error');
				span.setAttribute(
					'cache.status',
					'read-error',
				);

				logEvent(
					'warn',
					'asset.cache.read_failed',
					{
						requestId,
						assetId,
						...getErrorFields(error),
					},
				);
			}

			if (cachedValue !== null) {
				try {
					if (!cachedMetadata) {
						throw new TypeError(
							'Cached asset metadata is missing',
						);
					}

					if (
						cachedMetadata.kind !==
							'asset' &&
						cachedMetadata.kind !==
							'not-found'
					) {
						throw new TypeError(
							'Cached asset kind is invalid',
						);
					}

					if (
						typeof cachedMetadata.timestamp !==
							'number' ||
						!Number.isFinite(
							cachedMetadata.timestamp,
						)
					) {
						throw new TypeError(
							'Cached asset timestamp is invalid',
						);
					}

					if (
						cachedMetadata.kind ===
						'not-found'
					) {
						c.set(
							'cacheStatus',
							'negative-hit',
						);
						span.setAttribute(
							'cache.status',
							'negative-hit',
						);

						return c.json(
							{
								error:
									'Asset not found',
								requestId,
							},
							404,
							{
								'X-Cache-Hit':
									'true',
								'X-Cache-Status':
									'negative-hit',
								'X-Cache-Timestamp':
									cachedMetadata.timestamp.toString(),
							},
						);
					}

					if (
						typeof cachedMetadata.contentType !==
							'string' ||
						cachedMetadata.contentType.length ===
							0
					) {
						throw new TypeError(
							'Cached asset content type is invalid',
						);
					}

					if (cachedValue.byteLength === 0) {
						throw new TypeError(
							'Cached asset is empty',
						);
					}

					/*
					 * getWithMetadata(..., "arrayBuffer") guarantees an
					 * ArrayBuffer, so this is compatible with Hono's body type.
					 */
					const contentBytes: Uint8Array<ArrayBuffer> =
						new Uint8Array(cachedValue);

					c.set('cacheStatus', 'hit');
					span.setAttribute(
						'cache.status',
						'hit',
					);
					span.setAttribute(
						'asset.bytes',
						contentBytes.byteLength,
					);

					return c.body(
						contentBytes,
						200,
						{
							'Content-Type':
								cachedMetadata.contentType,
							...(cachedMetadata.extension
								? {
										[ASSET_EXTENSION_HEADER]:
											cachedMetadata.extension,
									}
								: {}),
							'X-Cache-Hit': 'true',
							'X-Cache-Status':
								'hit',
							'X-Cache-Timestamp':
								cachedMetadata.timestamp.toString(),
						},
					);
				} catch (error) {
					c.set(
						'cacheStatus',
						'corrupt',
					);
					span.setAttribute(
						'cache.status',
						'corrupt',
					);

					logEvent(
						'warn',
						'asset.cache.corrupt',
						{
							requestId,
							assetId,
							...getErrorFields(error),
						},
					);

					/*
					 * A corrupt cache entry should not prevent delivery.
					 * Delete it and continue to Roblox.
					 */
					try {
						await assetCache.delete(
							cacheKey,
						);
					} catch (deleteError) {
						logEvent(
							'warn',
							'asset.cache.delete_failed',
							{
								requestId,
								assetId,
								...getErrorFields(
									deleteError,
								),
							},
						);
					}
				}
			} else if (
				c.get('cacheStatus') !== 'read-error'
			) {
				c.set('cacheStatus', 'miss');
				span.setAttribute(
					'cache.status',
					'miss',
				);
			}

			let robloxResponse: Response;

			try {
				/*
				 * The outbound fetch is automatically recorded as a child of
				 * the asset.delivery span.
				 */
				const discoveryResponse = await fetch(
					v2Request?.url ?? buildRobloxV1Url(assetId),
					{
						...(v2Request?.init ?? {}),
						signal: AbortSignal.timeout(ROBLOX_TIMEOUT_MS),
					},
				);

				if (!useAssetDeliveryV2 || !discoveryResponse.ok) {
					robloxResponse = discoveryResponse;
				} else {
					const discovery = await parseRobloxV2Discovery(
						discoveryResponse,
					);
					assetTypeId = discovery.assetTypeId;
					robloxResponse = await fetch(discovery.location, {
						signal: AbortSignal.timeout(ROBLOX_TIMEOUT_MS),
					});
				}
			} catch (error) {
				if (error instanceof MalformedRobloxV2ResponseError) {
					throw new HTTPException(502, {
						message: error.message,
						cause: error,
					});
				}
				const timedOut =
					isTimeoutError(error);

				throw new HTTPException(
					timedOut ? 504 : 502,
					{
						message: timedOut
							? 'Roblox asset delivery timed out'
							: 'Unable to reach Roblox asset delivery',
						cause: error,
					},
				);
			}

			c.set(
				'upstreamStatus',
				robloxResponse.status,
			);
			span.setAttribute(
				'http.response.status_code',
				robloxResponse.status,
			);

			const contentType =
				robloxResponse.headers.get(
					'Content-Type',
				) ?? 'application/octet-stream';

			if (!robloxResponse.ok) {
				logEvent(
					'warn',
					'asset.upstream.rejected',
					{
						requestId,
						assetId,
						upstreamStatus:
							robloxResponse.status,
						upstreamStatusText:
							robloxResponse.statusText,
					},
				);

				/*
				 * Cache only definitive not-found responses. Rate limits,
				 * timeouts, permission errors, and server failures must be
				 * retried normally.
				 */
				if (
					robloxResponse.status === 404
				) {
					const timestamp = Date.now();
					let negativeCacheStatus:
						CacheStatus =
						'negative-write';

					/*
					 * The upstream body is not needed because this endpoint
					 * returns a consistent local error response.
					 */
					try {
						await robloxResponse.body?.cancel();
					} catch {
						// Body cancellation failure does not affect the response.
					}

					try {
						await assetCache.put(
							cacheKey,
							new ArrayBuffer(0),
							{
								expirationTtl:
									NEGATIVE_CACHE_TTL_SECONDS,
								metadata: {
									kind: 'not-found',
									timestamp,
								} satisfies CachedAssetMetadata,
							},
						);

						c.set(
							'cacheStatus',
							'negative-write',
						);
						span.setAttribute(
							'cache.status',
							'negative-write',
						);

						logEvent(
							'info',
							'asset.cache.negative_written',
							{
								requestId,
								assetId,
								expirationTtl:
									NEGATIVE_CACHE_TTL_SECONDS,
							},
						);
					} catch (error) {
						negativeCacheStatus =
							'write-error';

						c.set(
							'cacheStatus',
							'write-error',
						);
						span.setAttribute(
							'cache.status',
							'write-error',
						);

						logEvent(
							'warn',
							'asset.cache.negative_write_failed',
							{
								requestId,
								assetId,
								...getErrorFields(
									error,
								),
							},
						);
					}

					return c.json(
						{
							error:
								'Asset not found',
							requestId,
						},
						404,
						{
							'X-Cache-Hit':
								'false',
							'X-Cache-Status':
								negativeCacheStatus,
							'X-Cache-Timestamp':
								timestamp.toString(),
						},
					);
				}

				/*
				 * Forward other upstream errors without assuming that Roblox
				 * returned JSON. These responses are not cached.
				 */
				const errorBuffer =
					await robloxResponse.arrayBuffer();
				const errorBody:
					Uint8Array<ArrayBuffer> =
					new Uint8Array(errorBuffer);

				return c.body(
					errorBody,
					robloxResponse.status as ContentfulStatusCode,
					{
						'Content-Type':
							contentType,
						'X-Cache-Hit':
							'false',
						'X-Cache-Status':
							'bypass',
					},
				);
			}

			const resolvedExtension = await resolveAssetExtension(
				contentType,
				robloxResponse.body,
				assetTypeId,
			);
			assetExtension ??= resolvedExtension.extension;
			const robloxBuffer =
				await new Response(resolvedExtension.body).arrayBuffer();
			const robloxData:
				Uint8Array<ArrayBuffer> =
				new Uint8Array(robloxBuffer);

			if (robloxData.byteLength === 0) {
				throw new HTTPException(502, {
					message:
						'Roblox returned an empty asset',
				});
			}

			span.setAttribute(
				'asset.bytes',
				robloxData.byteLength,
			);

			const timestamp = Date.now();

			try {
				/*
				 * Store asset bytes directly as the KV value and keep small,
				 * JSON-serializable fields in KV metadata.
				 */
				await assetCache.put(
				cacheKey,
					robloxBuffer,
					{
						metadata: {
							kind: 'asset',
							timestamp,
							contentType,
							extension: assetExtension,
						} satisfies CachedAssetMetadata,
					},
				);
			} catch (error) {
				/*
				 * Cache degradation should not prevent a successfully fetched
				 * Roblox asset from being delivered.
				 */
				c.set(
					'cacheStatus',
					'write-error',
				);
				span.setAttribute(
					'cache.status',
					'write-error',
				);

				logEvent(
					'warn',
					'asset.cache.write_failed',
					{
						requestId,
						assetId,
						assetBytes:
							robloxData.byteLength,
						...getErrorFields(error),
					},
				);
			}

			return c.body(robloxData, 200, {
				'Content-Type': contentType,
				...(assetExtension
					? { [ASSET_EXTENSION_HEADER]: assetExtension }
					: {}),
				'X-Cache-Hit': 'false',
				'X-Cache-Status':
					c.get('cacheStatus'),
				'X-Cache-Timestamp':
					timestamp.toString(),
			});
		},
	);
});

/**
 * Logs uncaught errors once and returns a consistent public response.
 */
app.onError((error, c) => {
	const requestId = c.get('requestId');
	const status =
		error instanceof HTTPException
			? error.status
			: 500;

	logEvent('error', 'request.failed', {
		requestId,
		method: c.req.method,
		path: c.req.path,
		status,
		cacheStatus: c.get('cacheStatus'),
		upstreamStatus: c.get('upstreamStatus'),
		...getErrorFields(error),
	});

	return c.json(
		{
			error:
				error instanceof HTTPException
					? error.message
					: 'Internal server error',
			requestId,
		},
		status as ContentfulStatusCode,
	);
});

app.notFound((c) => {
	return c.json(
		{
			error: 'Not found',
			requestId: c.get('requestId'),
		},
		404,
	);
});

export default app;
