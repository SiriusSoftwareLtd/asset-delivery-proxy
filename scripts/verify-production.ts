import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type AssetKind = 'image' | 'font';

type AssetFixture = {
  id: string;
  kind: AssetKind;
  name: string;
};

type RobloxAsset = {
  data: Uint8Array;
  contentType: string | null;
  hash: string;
};

type ProxyAsset = {
  data: Uint8Array;
  contentType: string | null;
  extension: string;
  hash: string;
  cacheHit: boolean;
  cacheStatus: string;
  requestId: string;
  timestamp: number;
};

type BatchItem = {
  assetId: string;
  status: number;
  contentType?: string;
  extension?: string;
  cacheStatus: string;
  cacheHit: boolean;
  dataBase64?: string;
  error?: string;
};

type BatchResponse = {
  requestId: string;
  results: BatchItem[];
};

const DEFAULT_ASSET_FIXTURES_FILE = 'scripts/verify-production.assets.json';

const MAX_ASSET_FIXTURES = 25;

let ASSETS: AssetFixture[] = [];
let assetFixturesFile = '';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.gif', '.bmp', '.webp', '.tga']);

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2', '.eot', '.bin']);

const SUCCESS_CACHE_STATUSES = new Set(['hit', 'l1-hit', 'kv-fresh-hit', 'stale-hit', 'miss']);

const CACHE_HIT_STATUSES = new Set(['hit', 'l1-hit', 'kv-fresh-hit', 'stale-hit']);

const FRESH_CACHE_STATUSES = new Set(['hit', 'l1-hit', 'kv-fresh-hit']);

const ASSET_FRESH_TTL_MS = 24 * 60 * 60 * 1_000;

const ASSET_RETENTION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const CACHE_CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;

let hasLoadedEnvFromFile = false;

function loadEnv(): void {
  if (hasLoadedEnvFromFile) return;
  hasLoadedEnvFromFile = true;
  process.loadEnvFile('.env');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadAssetFixtures(): Promise<AssetFixture[]> {
  loadEnv();

  const configuredPath = process.env.ASSET_PROXY_TEST_ASSETS_FILE?.trim();

  assetFixturesFile = resolve(configuredPath || DEFAULT_ASSET_FIXTURES_FILE);

  let raw: string;

  try {
    raw = await readFile(assetFixturesFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        [
          `Asset fixture file not found: ${assetFixturesFile}`,
          'Create a private fixture file from scripts/verify-production.assets.example.json.',
          'Do not commit the private fixture file.',
          'Set ASSET_PROXY_TEST_ASSETS_FILE to use a different path.',
        ].join('\n'),
      );
    }

    throw new Error(`Unable to read asset fixture file: ${assetFixturesFile}`, { cause: error });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Asset fixture file is not valid JSON: ${assetFixturesFile}`, { cause: error });
  }

  assert(isRecord(parsed), 'Asset fixture file must contain a JSON object');

  assert(Array.isArray(parsed.assets), 'Asset fixture file must contain an assets array');

  assert(parsed.assets.length > 0, 'Asset fixture file must contain at least one asset');

  assert(
    parsed.assets.length <= MAX_ASSET_FIXTURES,
    `Asset fixture file cannot contain more than ${MAX_ASSET_FIXTURES} assets`,
  );

  const seenIds = new Set<string>();

  return parsed.assets.map((value, index): AssetFixture => {
    assert(isRecord(value), `assets[${index}] must be an object`);

    const id = typeof value.id === 'string' ? value.id.trim() : '';

    assert(/^\d{1,20}$/.test(id), `assets[${index}].id must be a decimal Roblox asset ID of up to 20 digits`);

    assert(value.kind === 'image' || value.kind === 'font', `assets[${index}].kind must be "image" or "font"`);

    assert(!seenIds.has(id), `Duplicate asset ID in fixture file: ${id}`);

    seenIds.add(id);

    const name =
      typeof value.name === 'string' && value.name.trim().length > 0 ? value.name.trim() : `${value.kind} ${id}`;

    return {
      id,
      kind: value.kind,
      name,
    };
  });
}

function requiredEnv(name: string): string {
  loadEnv();
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 48) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}

const baseUrl = requiredEnv('ASSET_PROXY_URL').replace(/\/+$/, '');

const robloxApiKey = requiredEnv('ROBLOX_API_KEY');

const timeoutMs = readPositiveInteger('ASSET_PROXY_TIMEOUT_MS', 35_000);

const cacheAttempts = readPositiveInteger('ASSET_PROXY_CACHE_ATTEMPTS', 5);

const cacheDelayMs = readPositiveInteger('ASSET_PROXY_CACHE_DELAY_MS', 1_000);

const parsedBaseUrl = new URL(baseUrl);

assert(
  parsedBaseUrl.protocol === 'https:' || process.env.ASSET_PROXY_ALLOW_HTTP === 'true',
  'ASSET_PROXY_URL must use HTTPS',
);

assert(!parsedBaseUrl.search, 'ASSET_PROXY_URL must not contain a query string');

assert(!parsedBaseUrl.hash, 'ASSET_PROXY_URL must not contain a URL fragment');

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();

  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs} ms: ${url}`, { cause: error });
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.clone().text()).slice(0, 1_000);
  } catch {
    return '<unable to read response body>';
  }
}

async function assertStatus(response: Response, expected: number, label: string): Promise<void> {
  if (response.status === expected) {
    return;
  }

  const body = await readErrorBody(response);

  const retryAfter = response.headers.get('Retry-After');

  throw new Error(
    [
      `${label}: expected HTTP ${expected}, got ${response.status}`,
      retryAfter ? `Retry-After: ${retryAfter}` : undefined,
      `Body: ${body}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function requireHeader(response: Response, name: string, label: string): string {
  const value = response.headers.get(name);

  assert(value !== null && value.length > 0, `${label}: missing ${name}`);

  return value;
}

async function runTest(name: string, callback: () => Promise<string | undefined>): Promise<void> {
  const startedAt = performance.now();

  process.stdout.write(`→ ${name} ... `);

  try {
    const detail = await callback();

    const duration = Math.round(performance.now() - startedAt);

    console.log(`PASS (${duration} ms)${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    console.log('FAIL');
    throw error;
  }
}

function assertExpectedExtension(fixture: AssetFixture, extension: string): void {
  const validExtensions = fixture.kind === 'image' ? IMAGE_EXTENSIONS : FONT_EXTENSIONS;

  assert(validExtensions.has(extension), `${fixture.name}: expected a ${fixture.kind} extension, got ${extension}`);
}

function verifyCacheAge(fixture: AssetFixture, proxy: ProxyAsset): number {
  const age = Date.now() - proxy.timestamp;

  assert(age >= -CACHE_CLOCK_TOLERANCE_MS, `${fixture.name}: cache timestamp is in the future`);

  if (FRESH_CACHE_STATUSES.has(proxy.cacheStatus)) {
    assert(
      age <= ASSET_FRESH_TTL_MS + CACHE_CLOCK_TOLERANCE_MS,
      `${fixture.name}: ${proxy.cacheStatus} is older than the 24-hour fresh TTL (${formatDuration(age)})`,
    );
  }

  if (proxy.cacheStatus === 'stale-hit') {
    assert(
      age <= ASSET_RETENTION_TTL_MS + CACHE_CLOCK_TOLERANCE_MS,
      `${fixture.name}: stale cache entry is older than the 7-day retention TTL (${formatDuration(age)})`,
    );
  }

  return age;
}

async function fetchRobloxAsset(fixture: AssetFixture): Promise<RobloxAsset> {
  const url = `https://apis.roblox.com/asset-delivery-api/v1/assetId/${fixture.id}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      'x-api-key': robloxApiKey,
    },
  });

  if (!response.ok) {
    const body = await readErrorBody(response);

    throw new Error(
      [
        `Roblox rejected ${fixture.name}`,
        `Asset ID: ${fixture.id}`,
        `HTTP ${response.status}`,
        response.headers.get('Retry-After') ? `Retry-After: ${response.headers.get('Retry-After')}` : undefined,
        `Body: ${body}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  const data = new Uint8Array(await response.arrayBuffer());

  assert(data.byteLength > 0, `Roblox returned an empty body for ${fixture.name}`);

  return {
    data,
    contentType: response.headers.get('Content-Type'),
    hash: sha256(data),
  };
}

async function fetchProxyAsset(fixture: AssetFixture): Promise<ProxyAsset> {
  const response = await fetchWithTimeout(`${baseUrl}/v1/assets/${fixture.id}`, {
    headers: {
      'X-Rayfield-Secure-Mode': 'true',
    },
  });

  await assertStatus(response, 200, `Proxy ${fixture.name}`);

  const requestId = requireHeader(response, 'X-Request-ID', fixture.name);

  const cacheHitValue = requireHeader(response, 'X-Cache-Hit', fixture.name);

  const cacheStatus = requireHeader(response, 'X-Cache-Status', fixture.name);

  const extension = requireHeader(response, 'X-Asset-Extension', fixture.name);

  assert(
    cacheHitValue === 'true' || cacheHitValue === 'false',
    `${fixture.name}: invalid X-Cache-Hit: ${cacheHitValue}`,
  );

  assert(SUCCESS_CACHE_STATUSES.has(cacheStatus), `${fixture.name}: unexpected cache status: ${cacheStatus}`);

  assertExpectedExtension(fixture, extension);

  const timestamp = Number(requireHeader(response, 'X-Cache-Timestamp', fixture.name));

  assert(Number.isFinite(timestamp) && timestamp > 0, `${fixture.name}: invalid X-Cache-Timestamp`);

  const data = new Uint8Array(await response.arrayBuffer());

  assert(data.byteLength > 0, `Proxy returned an empty body for ${fixture.name}`);

  return {
    data,
    contentType: response.headers.get('Content-Type'),
    extension,
    hash: sha256(data),
    cacheHit: cacheHitValue === 'true',
    cacheStatus,
    requestId,
    timestamp,
  };
}

async function verifyHealth(): Promise<string> {
  const response = await fetchWithTimeout(`${baseUrl}/health`);

  await assertStatus(response, 200, 'Health endpoint');

  requireHeader(response, 'X-Request-ID', 'Health endpoint');

  const body = await response.text();

  assert(body === 'OK', `Health endpoint returned ${JSON.stringify(body)}`);

  return 'Worker is healthy';
}

async function verifySecureMode(): Promise<string> {
  const fixture = ASSETS[0];

  const response = await fetchWithTimeout(`${baseUrl}/v1/assets/${fixture.id}`);

  await assertStatus(response, 403, 'Secure-mode enforcement');

  const cacheStatus = requireHeader(response, 'X-Cache-Status', 'Secure-mode enforcement');

  const cacheHit = requireHeader(response, 'X-Cache-Hit', 'Secure-mode enforcement');

  assert(cacheStatus === 'bypass', `Expected bypass, got ${cacheStatus}`);

  assert(cacheHit === 'false', 'Secure-mode rejection reported a cache hit');

  const body = (await response.json()) as {
    error?: unknown;
  };

  assert(body.error === 'Secure mode is required', `Unexpected secure-mode error: ${String(body.error)}`);

  return 'Missing secure-mode header returns 403';
}

async function verifyAgainstRoblox(fixture: AssetFixture): Promise<string> {
  const proxy = await fetchProxyAsset(fixture);

  const roblox = await fetchRobloxAsset(fixture);

  const cacheAge = verifyCacheAge(fixture, proxy);

  /*
   * A miss represents bytes fetched from
   * Roblox during this resolution.
   */
  if (!proxy.cacheHit) {
    assert(
      proxy.cacheStatus === 'miss',
      `${fixture.name}: non-cache response has unexpected status ${proxy.cacheStatus}`,
    );

    assert(
      proxy.hash === roblox.hash,
      [
        `${fixture.name}: fresh proxy response differs from Roblox`,
        `Proxy:  ${proxy.hash}, ${proxy.cacheStatus}`,
        `Roblox: ${roblox.hash}`,
      ].join('\n'),
    );

    return [
      fixture.kind,
      formatBytes(proxy.data.byteLength),
      `ext=${proxy.extension}`,
      'cache=miss',
      'matches=current-roblox',
      `sha256=${proxy.hash.slice(0, 16)}`,
    ].join(', ');
  }

  /*
   * Cached bytes represent the version
   * Roblox returned when the cache entry
   * was created.
   *
   * Roblox can update the contents behind
   * the same asset ID before our cache TTL
   * expires.
   */
  if (proxy.hash !== roblox.hash) {
    const confirmation = await fetchProxyAsset(fixture);

    verifyCacheAge(fixture, confirmation);

    /*
     * A stale hit can schedule a refresh.
     * The second response can therefore
     * contain either:
     *
     * - the same cached snapshot, or
     * - the newly refreshed Roblox bytes.
     */
    assert(
      confirmation.hash === proxy.hash || confirmation.hash === roblox.hash,
      [
        `${fixture.name}: cached response is not stable`,
        `First proxy:  ${proxy.hash}`,
        `Second proxy: ${confirmation.hash}`,
        `Roblox:       ${roblox.hash}`,
      ].join('\n'),
    );

    return [
      fixture.kind,
      formatBytes(proxy.data.byteLength),
      `ext=${proxy.extension}`,
      `cache=${proxy.cacheStatus}`,
      `age=${formatDuration(cacheAge)}`,
      'cached-snapshot!=current-roblox',
      `proxy=${proxy.hash.slice(0, 16)}`,
      `roblox=${roblox.hash.slice(0, 16)}`,
    ].join(', ');
  }

  return [
    fixture.kind,
    formatBytes(proxy.data.byteLength),
    `ext=${proxy.extension}`,
    `cache=${proxy.cacheStatus}`,
    `age=${formatDuration(cacheAge)}`,
    'matches=current-roblox',
    `sha256=${proxy.hash.slice(0, 16)}`,
  ].join(', ');
}

async function verifyCache(fixture: AssetFixture): Promise<string> {
  for (let attempt = 1; attempt <= cacheAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(cacheDelayMs);
    }

    const response = await fetchProxyAsset(fixture);

    verifyCacheAge(fixture, response);

    if (response.cacheHit && CACHE_HIT_STATUSES.has(response.cacheStatus)) {
      return (
        `hit on attempt ${attempt} ` +
        `(${response.cacheStatus}, age=${formatDuration(Date.now() - response.timestamp)})`
      );
    }
  }

  throw new Error(`${fixture.name}: no cache hit after ${cacheAttempts} attempts`);
}

async function verifyBatch(): Promise<string> {
  /*
   * Record the proxy representation before
   * requesting the batch.
   *
   * Batch responses should agree with the
   * representation served by the proxy,
   * not necessarily Roblox's latest bytes.
   */
  const before = await Promise.all(
    ASSETS.map(async (fixture) => ({
      fixture,
      proxy: await fetchProxyAsset(fixture),
    })),
  );

  const response = await fetchWithTimeout(`${baseUrl}/v1/assets/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Rayfield-Secure-Mode': 'true',
    },
    body: JSON.stringify({
      assetIds: ASSETS.map((fixture) => fixture.id),
    }),
  });

  await assertStatus(response, 200, 'Batch asset delivery');

  requireHeader(response, 'X-Request-ID', 'Batch asset delivery');

  const body = (await response.json()) as BatchResponse;

  assert(typeof body.requestId === 'string' && body.requestId.length > 0, 'Batch response is missing requestId');

  assert(Array.isArray(body.results), 'Batch response is missing results');

  assert(body.results.length === ASSETS.length, `Expected ${ASSETS.length} batch results, got ${body.results.length}`);

  for (let index = 0; index < ASSETS.length; index += 1) {
    const fixture = ASSETS[index];

    const result = body.results[index];

    const expected = before[index].proxy;

    assert(result.assetId === fixture.id, `Batch result ${index} did not preserve asset order`);

    assert(result.status === 200, `${fixture.name}: batch returned ${result.status}: ${result.error ?? ''}`);

    assert(
      typeof result.dataBase64 === 'string' && result.dataBase64.length > 0,
      `${fixture.name}: batch result is missing dataBase64`,
    );

    assert(typeof result.extension === 'string', `${fixture.name}: batch result is missing extension`);

    assertExpectedExtension(fixture, result.extension);

    const batchData = new Uint8Array(Buffer.from(result.dataBase64, 'base64'));

    const batchHash = sha256(batchData);

    if (batchHash === expected.hash) {
      continue;
    }

    /*
     * A stale cache entry may refresh
     * between the pre-batch request and
     * the batch request.
     *
     * Fetch once more and accept the
     * current proxy representation too.
     */
    const after = await fetchProxyAsset(fixture);

    assert(
      batchHash === after.hash,
      [
        `${fixture.name}: batch bytes differ from single-asset delivery`,
        `Before: ${expected.hash}`,
        `Batch:  ${batchHash}`,
        `After:  ${after.hash}`,
      ].join('\n'),
    );
  }

  return `${ASSETS.length} image/font assets matched single-asset delivery`;
}

async function verifyDuplicateBatch(): Promise<string> {
  const fixture = ASSETS[0];

  const response = await fetchWithTimeout(`${baseUrl}/v1/assets/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Rayfield-Secure-Mode': 'true',
    },
    body: JSON.stringify({
      assetIds: [fixture.id, fixture.id],
    }),
  });

  await assertStatus(response, 200, 'Duplicate batch');

  const body = (await response.json()) as BatchResponse;

  assert(body.results.length === 2, 'Duplicate batch did not return two results');

  const first = body.results[0];

  const second = body.results[1];

  assert(first.status === 200 && second.status === 200, 'Duplicate batch contained a failed result');

  assert(first.dataBase64 && second.dataBase64, 'Duplicate batch is missing asset data');

  const firstHash = sha256(new Uint8Array(Buffer.from(first.dataBase64, 'base64')));

  const secondHash = sha256(new Uint8Array(Buffer.from(second.dataBase64, 'base64')));

  assert(firstHash === secondHash, 'Duplicate asset IDs returned different bytes');

  return `${fixture.id} duplicate results match`;
}

async function main(): Promise<void> {
  ASSETS = await loadAssetFixtures();

  console.log('Asset Delivery Proxy production verification');

  console.log(`Target: ${baseUrl}`);

  console.log(`Fixtures: ${assetFixturesFile}`);

  console.log('');

  console.log('Test assets:');

  for (const fixture of ASSETS) {
    console.log(`  ${fixture.id} — ${fixture.kind}`);
  }

  console.log('');

  const startedAt = performance.now();

  await runTest('Health endpoint', verifyHealth);

  await runTest('Secure-mode enforcement', verifySecureMode);

  for (const fixture of ASSETS) {
    await runTest(`Roblox comparison: ${fixture.id}`, () => verifyAgainstRoblox(fixture));
  }

  for (const fixture of ASSETS) {
    await runTest(`Cache verification: ${fixture.id}`, () => verifyCache(fixture));
  }

  await runTest('Image/font batch delivery', verifyBatch);

  await runTest('Duplicate batch consistency', verifyDuplicateBatch);

  const duration = Math.round(performance.now() - startedAt);

  console.log('');

  console.log(`Production verification passed in ${duration} ms.`);
}

main().catch((error: unknown) => {
  console.error('');

  console.error('Production verification failed.');

  if (error instanceof Error) {
    console.error(error.stack);
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});
