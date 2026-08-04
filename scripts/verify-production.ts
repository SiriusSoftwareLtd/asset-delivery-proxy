import { createHash } from 'node:crypto';

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

const ASSETS: AssetFixture[] = [
	{ id: '83277910885129', kind: 'image', name: 'Image 83277910885129' },
	{ id: '108115485663409', kind: 'image', name: 'Image 108115485663409' },
	{ id: '10686484311', kind: 'image', name: 'Image 10686484311' },
	{ id: '10686489483', kind: 'image', name: 'Image 10686489483' },
	{ id: '9134770833', kind: 'image', name: 'Image 9134770833' },
	{ id: '112230965192631', kind: 'image', name: 'Image 112230965192631' },
	{ id: '4941333951', kind: 'image', name: 'Image 4941333951' },
	{ id: '12187365364', kind: 'font', name: 'Font 12187365364' },
];

const IMAGE_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.gif',
	'.bmp',
	'.webp',
	'.tga',
]);

const FONT_EXTENSIONS = new Set([
	'.ttf',
	'.otf',
	'.ttc',
	'.woff',
	'.woff2',
	'.eot',

	// Roblox font assets may resolve to a font-family descriptor rather
	// than the underlying font binary. The current proxy falls back to
	// .bin when it cannot identify a supported binary format.
	'.bin',
]);

const CACHE_HIT_STATUSES = new Set([
	'hit',
	'l1-hit',
	'kv-fresh-hit',
	'stale-hit',
	'negative-hit',
]);

const SUCCESS_CACHE_STATUSES = new Set([
	'hit',
	'l1-hit',
	'kv-fresh-hit',
	'stale-hit',
	'miss',
]);

let hasLoadedEnvFromFile = false;

function loadEnv(): void {
	if (hasLoadedEnvFromFile) return;
	hasLoadedEnvFromFile = true;
	console.log("Loading environment from .env file", process.cwd())
	process.loadEnvFile(".env");
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

function assert(
	condition: unknown,
	message: string,
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function sha256(data: Uint8Array): string {
	return createHash('sha256')
		.update(data)
		.digest('hex');
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

const baseUrl = requiredEnv('ASSET_PROXY_URL').replace(/\/+$/, '');
const robloxApiKey = requiredEnv('ROBLOX_API_KEY');

const timeoutMs = readPositiveInteger(
	'ASSET_PROXY_TIMEOUT_MS',
	35_000,
);

const cacheAttempts = readPositiveInteger(
	'ASSET_PROXY_CACHE_ATTEMPTS',
	5,
);

const cacheDelayMs = readPositiveInteger(
	'ASSET_PROXY_CACHE_DELAY_MS',
	1_000,
);

const parsedBaseUrl = new URL(baseUrl);

assert(
	parsedBaseUrl.protocol === 'https:' ||
		process.env.ASSET_PROXY_ALLOW_HTTP === 'true',
	'ASSET_PROXY_URL must use HTTPS',
);

assert(
	!parsedBaseUrl.search,
	'ASSET_PROXY_URL must not contain a query string',
);

assert(
	!parsedBaseUrl.hash,
	'ASSET_PROXY_URL must not contain a URL fragment',
);

async function fetchWithTimeout(
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	const controller = new AbortController();

	const timeout = setTimeout(
		() => controller.abort(),
		timeoutMs,
	);

	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(
				`Request timed out after ${timeoutMs} ms: ${url}`,
				{ cause: error },
			);
		}

		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function readErrorBody(
	response: Response,
): Promise<string> {
	try {
		return (await response.clone().text()).slice(0, 1_000);
	} catch {
		return '<unable to read response body>';
	}
}

async function assertStatus(
	response: Response,
	expected: number,
	label: string,
): Promise<void> {
	if (response.status === expected) {
		return;
	}

	const body = await readErrorBody(response);
	const retryAfter = response.headers.get('Retry-After');

	throw new Error(
		[
			`${label}: expected HTTP ${expected}, got ${response.status}`,
			retryAfter
				? `Retry-After: ${retryAfter}`
				: undefined,
			`Body: ${body}`,
		]
			.filter(Boolean)
			.join('\n'),
	);
}

function requireHeader(
	response: Response,
	name: string,
	label: string,
): string {
	const value = response.headers.get(name);

	assert(
		value !== null && value.length > 0,
		`${label}: missing ${name}`,
	);

	return value;
}

async function runTest(
	name: string,
	callback: () => Promise<string | void>,
): Promise<void> {
	const startedAt = performance.now();

	process.stdout.write(`→ ${name} ... `);

	try {
		const detail = await callback();

		const duration = Math.round(
			performance.now() - startedAt,
		);

		console.log(
			`PASS (${duration} ms)${detail ? ` — ${detail}` : ''}`,
		);
	} catch (error) {
		console.log('FAIL');
		throw error;
	}
}

function assertExpectedExtension(
	fixture: AssetFixture,
	extension: string,
): void {
	const validExtensions =
		fixture.kind === 'image'
			? IMAGE_EXTENSIONS
			: FONT_EXTENSIONS;

	assert(
		validExtensions.has(extension),
		`${fixture.name}: expected a ${fixture.kind} extension, got ${extension}`,
	);
}

async function fetchRobloxAsset(
	fixture: AssetFixture,
): Promise<RobloxAsset> {
	const url =
		`https://apis.roblox.com/asset-delivery-api/v1/assetId/${fixture.id}`;

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
				response.headers.get('Retry-After')
					? `Retry-After: ${response.headers.get('Retry-After')}`
					: undefined,
				`Body: ${body}`,
			]
				.filter(Boolean)
				.join('\n'),
		);
	}

	const data = new Uint8Array(
		await response.arrayBuffer(),
	);

	assert(
		data.byteLength > 0,
		`Roblox returned an empty body for ${fixture.name}`,
	);

	return {
		data,
		contentType: response.headers.get('Content-Type'),
		hash: sha256(data),
	};
}

async function fetchProxyAsset(
	fixture: AssetFixture,
): Promise<ProxyAsset> {
	const response = await fetchWithTimeout(
		`${baseUrl}/assets/${fixture.id}`,
		{
			headers: {
				'X-Rayfield-Secure-Mode': 'true',
			},
		},
	);

	await assertStatus(
		response,
		200,
		`Proxy ${fixture.name}`,
	);

	const requestId = requireHeader(
		response,
		'X-Request-ID',
		fixture.name,
	);

	const cacheHitValue = requireHeader(
		response,
		'X-Cache-Hit',
		fixture.name,
	);

	const cacheStatus = requireHeader(
		response,
		'X-Cache-Status',
		fixture.name,
	);

	const extension = requireHeader(
		response,
		'X-Asset-Extension',
		fixture.name,
	);

	assert(
		cacheHitValue === 'true' ||
			cacheHitValue === 'false',
		`${fixture.name}: invalid X-Cache-Hit: ${cacheHitValue}`,
	);

	assert(
		SUCCESS_CACHE_STATUSES.has(cacheStatus),
		`${fixture.name}: unexpected cache status: ${cacheStatus}`,
	);

	assertExpectedExtension(
		fixture,
		extension,
	);

	const timestamp = Number(
		requireHeader(
			response,
			'X-Cache-Timestamp',
			fixture.name,
		),
	);

	assert(
		Number.isFinite(timestamp) && timestamp > 0,
		`${fixture.name}: invalid X-Cache-Timestamp`,
	);

	const data = new Uint8Array(
		await response.arrayBuffer(),
	);

	assert(
		data.byteLength > 0,
		`Proxy returned an empty body for ${fixture.name}`,
	);

	return {
		data,
		contentType: response.headers.get('Content-Type'),
		extension,
		hash: sha256(data),
		cacheHit: cacheHitValue === 'true',
		cacheStatus,
		requestId,
	};
}

async function verifyHealth(): Promise<string> {
	const response = await fetchWithTimeout(
		`${baseUrl}/health`,
	);

	await assertStatus(
		response,
		200,
		'Health endpoint',
	);

	requireHeader(
		response,
		'X-Request-ID',
		'Health endpoint',
	);

	const body = await response.text();

	assert(
		body === 'OK',
		`Health endpoint returned ${JSON.stringify(body)}`,
	);

	return 'Worker is healthy';
}

async function verifySecureMode(): Promise<string> {
	const fixture = ASSETS[0];

	const response = await fetchWithTimeout(
		`${baseUrl}/assets/${fixture.id}`,
	);

	await assertStatus(
		response,
		403,
		'Secure-mode enforcement',
	);

	const cacheStatus = requireHeader(
		response,
		'X-Cache-Status',
		'Secure-mode enforcement',
	);

	const cacheHit = requireHeader(
		response,
		'X-Cache-Hit',
		'Secure-mode enforcement',
	);

	assert(
		cacheStatus === 'bypass',
		`Expected bypass, got ${cacheStatus}`,
	);

	assert(
		cacheHit === 'false',
		'Secure-mode rejection reported a cache hit',
	);

	const body = await response.json() as {
		error?: unknown;
	};

	assert(
		body.error === 'Secure mode is required',
		`Unexpected secure-mode error: ${String(body.error)}`,
	);

	return 'Missing secure-mode header returns 403';
}

async function verifyAgainstRoblox(
	fixture: AssetFixture,
): Promise<string> {
	const [roblox, proxy] = await Promise.all([
		fetchRobloxAsset(fixture),
		fetchProxyAsset(fixture),
	]);

	assert(
		proxy.hash === roblox.hash,
		[
			`${fixture.name}: proxy bytes differ from Roblox`,
			`Proxy:  ${proxy.hash}`,
			`Roblox: ${roblox.hash}`,
			`Cache:  ${proxy.cacheStatus}`,
		].join('\n'),
	);

	if (
		proxy.contentType &&
		roblox.contentType &&
		proxy.contentType.toLowerCase() !==
			roblox.contentType.toLowerCase()
	) {
		throw new Error(
			[
				`${fixture.name}: Content-Type differs from Roblox`,
				`Proxy:  ${proxy.contentType}`,
				`Roblox: ${roblox.contentType}`,
			].join('\n'),
		);
	}

	return [
		`${fixture.kind}`,
		formatBytes(proxy.data.byteLength),
		`ext=${proxy.extension}`,
		`cache=${proxy.cacheStatus}`,
		`sha256=${proxy.hash.slice(0, 16)}`,
	].join(', ');
}

async function verifyCache(
	fixture: AssetFixture,
): Promise<string> {
	for (
		let attempt = 1;
		attempt <= cacheAttempts;
		attempt += 1
	) {
		if (attempt > 1) {
			await sleep(cacheDelayMs);
		}

		const response = await fetchProxyAsset(
			fixture,
		);

		if (response.cacheStatus === 'write-error') {
			throw new Error(
				`${fixture.name}: cache write failed`,
			);
		}

		if (
			response.cacheHit &&
			CACHE_HIT_STATUSES.has(
				response.cacheStatus,
			)
		) {
			return (
				`hit on attempt ${attempt} ` +
				`(${response.cacheStatus})`
			);
		}
	}

	throw new Error(
		`${fixture.name}: no cache hit after ${cacheAttempts} attempts`,
	);
}

async function verifyBatch(): Promise<string> {
	const robloxResults = await Promise.all(
		ASSETS.map(async (fixture) => ({
			fixture,
			roblox: await fetchRobloxAsset(fixture),
		})),
	);

	const response = await fetchWithTimeout(
		`${baseUrl}/assets/batch`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Rayfield-Secure-Mode': 'true',
			},
			body: JSON.stringify({
				assetIds: ASSETS.map(
					(fixture) => fixture.id,
				),
			}),
		},
	);

	await assertStatus(
		response,
		200,
		'Batch asset delivery',
	);

	requireHeader(
		response,
		'X-Request-ID',
		'Batch asset delivery',
	);

	const body =
		await response.json() as BatchResponse;

	assert(
		Array.isArray(body.results),
		'Batch response is missing results',
	);

	assert(
		body.results.length === ASSETS.length,
		`Expected ${ASSETS.length} batch results, got ${body.results.length}`,
	);

	for (
		let index = 0;
		index < ASSETS.length;
		index += 1
	) {
		const fixture = ASSETS[index];
		const result = body.results[index];
		const roblox =
			robloxResults[index].roblox;

		assert(
			result.assetId === fixture.id,
			`Batch result ${index} did not preserve asset order`,
		);

		assert(
			result.status === 200,
			`${fixture.name}: batch returned ${result.status}: ${result.error ?? ''}`,
		);

		assert(
			typeof result.dataBase64 === 'string' &&
				result.dataBase64.length > 0,
			`${fixture.name}: batch result is missing dataBase64`,
		);

		assert(
			typeof result.extension === 'string',
			`${fixture.name}: batch result is missing extension`,
		);

		assertExpectedExtension(
			fixture,
			result.extension,
		);

		const data = new Uint8Array(
			Buffer.from(
				result.dataBase64,
				'base64',
			),
		);

		const hash = sha256(data);

		assert(
			hash === roblox.hash,
			[
				`${fixture.name}: batch bytes differ from Roblox`,
				`Batch:  ${hash}`,
				`Roblox: ${roblox.hash}`,
			].join('\n'),
		);
	}

	return `${ASSETS.length} image/font assets matched Roblox`;
}

async function verifyDuplicateBatch(): Promise<string> {
	const fixture = ASSETS[0];

	const response = await fetchWithTimeout(
		`${baseUrl}/assets/batch`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Rayfield-Secure-Mode': 'true',
			},
			body: JSON.stringify({
				assetIds: [
					fixture.id,
					fixture.id,
				],
			}),
		},
	);

	await assertStatus(
		response,
		200,
		'Duplicate batch',
	);

	const body =
		await response.json() as BatchResponse;

	assert(
		body.results.length === 2,
		'Duplicate batch did not return two results',
	);

	const first = body.results[0];
	const second = body.results[1];

	assert(
		first.status === 200 &&
			second.status === 200,
		'Duplicate batch contained a failed result',
	);

	assert(
		first.dataBase64 &&
			second.dataBase64,
		'Duplicate batch is missing asset data',
	);

	const firstHash = sha256(
		new Uint8Array(
			Buffer.from(
				first.dataBase64,
				'base64',
			),
		),
	);

	const secondHash = sha256(
		new Uint8Array(
			Buffer.from(
				second.dataBase64,
				'base64',
			),
		),
	);

	assert(
		firstHash === secondHash,
		'Duplicate asset IDs returned different bytes',
	);

	return `${fixture.id} duplicate results match`;
}

async function main(): Promise<void> {
	console.log(
		'Asset Delivery Proxy production verification',
	);

	console.log(`Target: ${baseUrl}`);
	console.log('');

	console.log('Test assets:');

	for (const fixture of ASSETS) {
		console.log(
			`  ${fixture.id} — ${fixture.kind}`,
		);
	}

	console.log('');

	const startedAt = performance.now();

	await runTest(
		'Health endpoint',
		verifyHealth,
	);

	await runTest(
		'Secure-mode enforcement',
		verifySecureMode,
	);

	for (const fixture of ASSETS) {
		await runTest(
			`Roblox comparison: ${fixture.id}`,
			() => verifyAgainstRoblox(fixture),
		);
	}

	for (const fixture of ASSETS) {
		await runTest(
			`Cache verification: ${fixture.id}`,
			() => verifyCache(fixture),
		);
	}

	await runTest(
		'Image/font batch delivery',
		verifyBatch,
	);

	await runTest(
		'Duplicate batch consistency',
		verifyDuplicateBatch,
	);

	const duration = Math.round(
		performance.now() - startedAt,
	);

	console.log('');
	console.log(
		`Production verification passed in ${duration} ms.`,
	);
}

main().catch((error: unknown) => {
	console.error('');
	console.error(
		'Production verification failed.',
	);

	if (error instanceof Error) {
		console.error(error.stack);
	} else {
		console.error(error);
	}

	process.exitCode = 1;
});
