import { isTimeoutError } from '../../utils/errors';
import { fetchWithTimeout } from '../../utils/fetch';

const ROBLOX_ASSET_DELIVERY_ORIGIN = 'https://assetdelivery.roblox.com';
const ROBLOX_OPEN_CLOUD_ASSET_DELIVERY_ORIGIN = 'https://apis.roblox.com';
const ROBLOX_TIMEOUT_MS = 10_000;

/** Query parameters accepted by Roblox's v2 asset delivery endpoint. */
export const ROBLOX_V2_QUERY_PARAMS = [
  'accessContext',
  'assetName',
  'assetVersionId',
  'clientInsert',
  'contentRepresentationPriorityList',
  'doNotFallbackToBaselineRepresentation',
  'expectedAssetType',
  'hash',
  'marAssetHash',
  'marCheckSum',
  'modulePlaceId',
  'permissionContext',
  'scriptinsert',
  'serverplaceid',
  'skipSigningScripts',
  'universeId',
] as const;

/** Headers accepted by Roblox's v2 asset delivery endpoint. */
export const ROBLOX_V2_HEADERS = [
  'Accept',
  'Accept-Encoding',
  'AssetFormat',
  'AssetType',
  'Roblox-AssetFormat',
  'Roblox-Place-Id',
] as const;

export type RobloxV2Request = {
  url: string;
  init: RequestInit;
  cacheKey: string;
};

export type RobloxV2Discovery = {
  location: string;
  assetTypeId?: number;
};

export class MalformedRobloxV2ResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedRobloxV2ResponseError';
  }
}

/** A discovery response Roblox answered with an explicit rejection rather than a location. */
export class RobloxV2RejectedError extends Error {
  readonly upstreamCode: number | undefined;

  constructor(message: string, upstreamCode: number | undefined) {
    super(message);
    this.name = 'RobloxV2RejectedError';
    this.upstreamCode = upstreamCode;
  }
}

/**
 * Roblox reports permission, moderation, and archival failures as HTTP 200 with an `errors`
 * array, so a 2xx discovery response is not on its own proof of a usable result. Reading the
 * rejection here keeps those distinguishable from a genuinely malformed body.
 */
function readRejection(value: object): RobloxV2RejectedError | undefined {
  const errors = (value as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined;
  }

  const first = errors.find((entry): entry is { code?: unknown; message?: unknown } => {
    return !!entry && typeof entry === 'object';
  });

  const code = typeof first?.code === 'number' && Number.isInteger(first.code) ? first.code : undefined;
  const message =
    typeof first?.message === 'string' && first.message.length > 0
      ? first.message
      : 'Roblox rejected the asset request';

  return new RobloxV2RejectedError(message, code);
}

/**
 * Roblox's own rejection code, when it is one a caller can act on. Anything else reads as a
 * gateway failure, keeping the 502/504 distinction the rest of delivery relies on.
 */
export function rejectionStatus(upstreamCode: number | undefined): 401 | 403 | 404 | 502 {
  if (upstreamCode === 401 || upstreamCode === 403 || upstreamCode === 404) {
    return upstreamCode;
  }
  return 502;
}

export function buildRobloxV1Url(assetId: string): string {
  return `${ROBLOX_ASSET_DELIVERY_ORIGIN}/v1/asset/?id=${encodeURIComponent(assetId)}`;
}

function buildOpenCloudAssetDeliveryUrl(protocol: 'v1' | 'v2', upstreamUrl: string): string | undefined {
  const parsed = new URL(upstreamUrl);
  const assetId =
    protocol === 'v2'
      ? parsed.pathname.match(/^\/v2\/assetId\/([^/]+)$/)?.[1]
      : parsed.pathname === '/v1/asset/'
        ? parsed.searchParams.get('id')
        : undefined;

  if (!assetId) return undefined;

  const url = new URL(
    `/asset-delivery-api/v1/assetId/${encodeURIComponent(decodeURIComponent(assetId))}`,
    ROBLOX_OPEN_CLOUD_ASSET_DELIVERY_ORIGIN,
  );
  for (const [name, value] of parsed.searchParams) {
    if (protocol === 'v1' && name === 'id') continue;
    url.searchParams.append(name, value);
  }
  return url.toString();
}

/**
 * Builds the v2 discovery request and a stable cache-key suffix from only
 * the request fields Roblox documents for this endpoint.
 */
export function buildRobloxV2Request(assetId: string, request: Request): RobloxV2Request {
  const incomingUrl = new URL(request.url);
  const url = new URL(`${ROBLOX_ASSET_DELIVERY_ORIGIN}/v2/assetId/${encodeURIComponent(assetId)}`);

  for (const name of ROBLOX_V2_QUERY_PARAMS) {
    for (const value of incomingUrl.searchParams.getAll(name)) {
      url.searchParams.append(name, value);
    }
  }

  const headers = new Headers();
  const cacheHeaders: string[] = [];
  for (const name of ROBLOX_V2_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
      cacheHeaders.push(`${name}=${value}`);
    }
  }

  const query = url.searchParams.toString();
  const cacheKey = ['v2', assetId, query, ...cacheHeaders].join('|');

  return {
    url: url.toString(),
    init: { headers },
    cacheKey,
  };
}

export function getFirstRobloxV2Discovery(value: unknown): RobloxV2Discovery {
  if (!value || typeof value !== 'object') {
    throw new MalformedRobloxV2ResponseError('Roblox v2 returned malformed JSON');
  }

  const rejection = readRejection(value);
  if (rejection) {
    throw rejection;
  }

  const response = value as { location?: unknown; locations?: unknown; assetTypeId?: unknown };
  const locations = typeof response.location === 'string' ? [response.location] : response.locations;
  const candidates = Array.isArray(locations) ? locations : [];

  for (const candidate of candidates) {
    const location = typeof candidate === 'string' ? candidate : (candidate as { location?: unknown })?.location;
    if (typeof location !== 'string' || location.length === 0) continue;

    try {
      const parsed = new URL(location);
      if (parsed.protocol === 'https:') {
        const assetTypeId = response.assetTypeId;
        return {
          location: parsed.toString(),
          assetTypeId: typeof assetTypeId === 'number' && Number.isInteger(assetTypeId) ? assetTypeId : undefined,
        };
      }
    } catch {
      // Try the next location, if Roblox supplied one.
    }
  }

  throw new MalformedRobloxV2ResponseError('Roblox v2 response has no valid location');
}

export async function parseRobloxV2Discovery(response: Response): Promise<RobloxV2Discovery> {
  try {
    return getFirstRobloxV2Discovery(await response.json());
  } catch (error) {
    if (error instanceof MalformedRobloxV2ResponseError || error instanceof RobloxV2RejectedError) throw error;
    throw new MalformedRobloxV2ResponseError('Roblox v2 returned invalid JSON');
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }

  const date = Date.parse(value);
  if (!Number.isFinite(date) || date <= now) return undefined;
  return Math.ceil((date - now) / 1_000);
}

export function isRetryableUpstreamStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export type RobloxResolution =
  | {
      kind: 'response';
      response: Response;
      assetTypeId?: number;
    }
  | {
      kind: 'rejection';
      status: number;
      error: string;
      upstreamStatus?: number;
      retryable: boolean;
    };

function isJsonResponse(response: Response): boolean {
  return response.headers.get('Content-Type')?.toLowerCase().includes('json') ?? false;
}

export async function fetchRobloxAsset(
  protocol: 'v1' | 'v2',
  upstreamUrl: string,
  upstreamHeaders: Record<string, string>,
  apiKey?: string,
  deadline?: number,
): Promise<RobloxResolution> {
  try {
    const headers = new Headers(upstreamHeaders);
    const authenticatedUrl = apiKey ? buildOpenCloudAssetDeliveryUrl(protocol, upstreamUrl) : undefined;
    if (apiKey) headers.set('x-api-key', apiKey);

    const discoveryTimeoutMs = Math.max(
      1,
      Math.min(ROBLOX_TIMEOUT_MS, (deadline ?? Number.POSITIVE_INFINITY) - Date.now()),
    );

    const discoveryResponse = await fetchWithTimeout(authenticatedUrl ?? upstreamUrl, { headers }, discoveryTimeoutMs);

    if (!discoveryResponse.ok) {
      return { kind: 'response', response: discoveryResponse };
    }

    if (protocol === 'v1' && !authenticatedUrl) {
      return { kind: 'response', response: discoveryResponse };
    }

    if (protocol === 'v2' && authenticatedUrl && !isJsonResponse(discoveryResponse)) {
      return { kind: 'response', response: discoveryResponse };
    }

    const discovery = await parseRobloxV2Discovery(discoveryResponse);
    const assetTimeoutMs = Math.max(
      1,
      Math.min(ROBLOX_TIMEOUT_MS, (deadline ?? Number.POSITIVE_INFINITY) - Date.now()),
    );

    const response = await fetchWithTimeout(discovery.location, { headers: upstreamHeaders }, assetTimeoutMs);

    return { kind: 'response', response, assetTypeId: discovery.assetTypeId };
  } catch (error) {
    if (error instanceof RobloxV2RejectedError) {
      return {
        kind: 'rejection',
        status: rejectionStatus(error.upstreamCode),
        error: error.message,
        upstreamStatus: error.upstreamCode,
        retryable: false,
      };
    }
    if (error instanceof MalformedRobloxV2ResponseError) {
      return { kind: 'rejection', status: 502, error: error.message, retryable: false };
    }
    return {
      kind: 'rejection',
      status: isTimeoutError(error) ? 504 : 502,
      error: isTimeoutError(error) ? 'Roblox asset delivery timed out' : 'Unable to reach Roblox asset delivery',
      retryable: true,
    };
  }
}
