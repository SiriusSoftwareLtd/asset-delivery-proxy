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
    if (error instanceof MalformedRobloxV2ResponseError) throw error;
    throw new MalformedRobloxV2ResponseError('Roblox v2 returned invalid JSON');
  }
}
