const ROBLOX_ASSET_DELIVERY_ORIGIN = 'https://assetdelivery.roblox.com';

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

  const locations = (value as { locations?: unknown }).locations;
  if (!Array.isArray(locations)) {
    throw new MalformedRobloxV2ResponseError('Roblox v2 response has no locations');
  }

  for (const candidate of locations) {
    if (!candidate || typeof candidate !== 'object') continue;
    const location = (candidate as { location?: unknown }).location;
    if (typeof location !== 'string' || location.length === 0) continue;

    try {
      const parsed = new URL(location);
      if (parsed.protocol === 'https:') {
        const assetTypeId = (value as { assetTypeId?: unknown }).assetTypeId;
        return {
          location: parsed.toString(),
          assetTypeId: typeof assetTypeId === 'number' && Number.isInteger(assetTypeId) ? assetTypeId : undefined,
        };
      }
    } catch {
      // Try the next location, if Roblox supplied one.
    }
  }

  throw new MalformedRobloxV2ResponseError('Roblox v2 response has no valid locations');
}

export async function parseRobloxV2Discovery(response: Response): Promise<RobloxV2Discovery> {
  try {
    return getFirstRobloxV2Discovery(await response.json());
  } catch (error) {
    if (error instanceof MalformedRobloxV2ResponseError || error instanceof RobloxV2RejectedError) throw error;
    throw new MalformedRobloxV2ResponseError('Roblox v2 returned invalid JSON');
  }
}
