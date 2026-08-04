import { isTimeoutError } from '../../utils/errors';
import { readBoundedBody } from './body';
import { MAX_PNG_BYTES, UPSTREAM_TIMEOUT_MS } from './constants';
import { IconError } from './errors';
import { rawGitHubUrl } from './sources';

const RAYFIELD_ICON_IDS = {
  close: '83277910885129',
  minimise: '108115485663409',
  maximise: '88738500661569',
  settings: '129180860773723',
  search: '100604009889706',
  chevron: '88479147175134',
  check: '125626312718314',
  dot: '91452555903853',
  colorpicker: '91452555903853',
  banner: '111263549366178',
  config: '125823673784681',
  rayfield: '80387863064905',
} as const;

export type RayfieldIconName = keyof typeof RAYFIELD_ICON_IDS;

export function resolveRayfieldIconId(iconName: string): string | undefined {
  if (!Object.hasOwn(RAYFIELD_ICON_IDS, iconName)) {
    return undefined;
  }

  return RAYFIELD_ICON_IDS[iconName as RayfieldIconName];
}

function getRayfieldIconUrlFromId(assetId: string): string {
  return rawGitHubUrl('SiriusSoftwareLtd', 'rayfield-gen2', 'main', 'assets', `${assetId}.png`);
}

async function readRayfieldPngBody(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  return readBoundedBody(response, MAX_PNG_BYTES, () => {
    return new IconError('PNG_TOO_LARGE', `PNG exceeds the ${MAX_PNG_BYTES}-byte limit`, {
      stage: 'upstream',
      retryable: false,
    });
  });
}

export async function fetchRayfieldIcon(assetId: string): Promise<Uint8Array<ArrayBuffer>> {
  const url = getRayfieldIconUrlFromId(assetId);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'image/png',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (response.status === 404) {
      throw new IconError('ICON_NOT_FOUND', 'The requested icon does not exist', {
        stage: 'upstream',
        retryable: false,
        upstreamStatus: 404,
      });
    }
    if (!response.ok) {
      throw new IconError('UPSTREAM_HTTP_ERROR', 'Failed to fetch icon', {
        stage: 'upstream',
        retryable: false,
        upstreamStatus: response.status,
      });
    }
    // check content length
    const declaredLength = response.headers.get('content-length');

    if (declaredLength !== null) {
      const declaredBytes = Number(declaredLength);

      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PNG_BYTES) {
        throw new IconError('PNG_TOO_LARGE', `PNG exceeds the ${MAX_PNG_BYTES}-byte limit`, {
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
    if (contentType && contentType !== 'image/png') {
      throw new IconError('INVALID_CONTENT_TYPE', `Icon source returned ${contentType}`, {
        stage: 'upstream',
        retryable: false,
      });
    }

    return readRayfieldPngBody(response);
  } catch (error) {
    if (error instanceof IconError) throw error;

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
}
