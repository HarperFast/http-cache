import { suite, test, before, after } from 'node:test';
import { strictEqual, notStrictEqual, ok, match } from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harperPackage = process.env.HARPER_PACKAGE ?? 'harper';
const COMPONENT_EXCLUDES = new Set(['node_modules', '.git', '.github', 'integrationTests']);

async function getHarperBinPath(): Promise<string> {
	const packageDir = join(repoRoot, 'node_modules', harperPackage);
	const { bin } = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
	return join(packageDir, bin.harper ?? bin.harperdb);
}

// Installs this component under the app's node_modules, the way a consuming application loads it
async function createFixtureApp(): Promise<string> {
	const workDir = await mkdtemp(join(tmpdir(), 'http-cache-fixture-'));
	const appDir = join(workDir, 'http-cache-test-app');
	await cp(join(repoRoot, 'integrationTests', 'fixture'), appDir, { recursive: true });
	await cp(repoRoot, join(appDir, 'node_modules', '@harperdb', 'http-cache'), {
		recursive: true,
		filter: (source) => source === repoRoot || !COMPONENT_EXCLUDES.has(basename(source)),
	});
	return appDir;
}

function basicAuth(username: string, password: string): string {
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function sendOperation(ctx: ContextWithHarper, operation: Record<string, unknown>): Promise<unknown> {
	const { username, password } = ctx.harper.admin;
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': basicAuth(username, password) },
		body: JSON.stringify(operation),
	});
	const body = await response.text();
	strictEqual(response.status, 200, body);
	return JSON.parse(body);
}

function assertCacheStatus(response: Response, expected: string): void {
	strictEqual(response.headers.get('X-Harper-Cache'), expected);
	strictEqual(response.headers.get('X-HarperDB-Cache'), expected);
}

suite(`http-cache middleware on ${harperPackage}`, (ctx: ContextWithHarper) => {
	let fixtureApp: string;

	before(async () => {
		fixtureApp = await createFixtureApp();
		await setupHarperWithFixture(ctx, fixtureApp, {
			harperBinPath: await getHarperBinPath(),
			// Harper 4 prompts for the terms agreement on first install
			env: { TC_AGREEMENT: 'yes' },
		});
	});

	after(async () => {
		await teardownHarper(ctx);
		await rm(dirname(fixtureApp), { recursive: true, force: true });
	});

	test('serves a MISS from the origin, then a HIT from the cache', async () => {
		const url = `${ctx.harper.httpURL}/origin/miss-then-hit`;

		const miss = await fetch(url);
		const missBody = await miss.text();
		strictEqual(miss.status, 200);
		assertCacheStatus(miss, 'MISS');
		match(missBody, /^origin response \d+ for \/origin\/miss-then-hit$/);

		const hit = await fetch(url);
		strictEqual(hit.status, 200);
		assertCacheStatus(hit, 'HIT');
		strictEqual(await hit.text(), missBody);
		ok(hit.headers.get('ETag'), 'a cache hit should carry an ETag');
		ok(hit.headers.get('Age') !== null, 'a cache hit should carry an Age');
	});

	test('serves a large, file-backed body from the cache', async () => {
		const url = `${ctx.harper.httpURL}/origin/large/body`;

		const miss = await fetch(url);
		const missBody = await miss.text();
		assertCacheStatus(miss, 'MISS');
		ok(missBody.length > 8192, `expected a large body, got ${missBody.length} bytes`);

		const hit = await fetch(url);
		assertCacheStatus(hit, 'HIT');
		strictEqual(await hit.text(), missBody);
	});

	test('stores the response without either cache status header', async () => {
		const id = '/origin/stored-headers';
		const miss = await fetch(`${ctx.harper.httpURL}${id}`);
		await miss.arrayBuffer();
		assertCacheStatus(miss, 'MISS');

		const [record] = (await sendOperation(ctx, {
			operation: 'search_by_id',
			database: 'cache',
			table: 'HttpCache',
			ids: [id],
			get_attributes: ['id', 'headers'],
		})) as Array<{ id: string; headers: Record<string, unknown> }>;
		strictEqual(record?.id, id);
		strictEqual(record.headers['content-type'], 'text/plain');
		const storedNames = Object.keys(record.headers).map((name) => name.toLowerCase());
		ok(!storedNames.includes('x-harper-cache'), `stored headers: ${storedNames.join(', ')}`);
		ok(!storedNames.includes('x-harperdb-cache'), `stored headers: ${storedNames.join(', ')}`);
	});

	test('returns 304 for a matching If-None-Match', async () => {
		const url = `${ctx.harper.httpURL}/origin/conditional`;
		await (await fetch(url)).arrayBuffer();
		const hit = await fetch(url);
		await hit.arrayBuffer();
		const etag = hit.headers.get('ETag');
		ok(etag, 'a cache hit should carry an ETag');

		const notModified = await fetch(url, { headers: { 'If-None-Match': etag } });
		await notModified.arrayBuffer();
		strictEqual(notModified.status, 304);
		assertCacheStatus(notModified, 'HIT');
	});

	test('rejects invalidation without super user credentials', async () => {
		await sendOperation(ctx, { operation: 'add_role', role: 'cache_reader', permission: { super_user: false } });
		await sendOperation(ctx, {
			operation: 'add_user',
			role: 'cache_reader',
			username: 'cache_reader',
			password: 'Cache-reader-1',
			active: true,
		});
		const response = await fetch(`${ctx.harper.httpURL}/invalidate`, {
			method: 'POST',
			headers: { Authorization: basicAuth('cache_reader', 'Cache-reader-1') },
		});
		await response.arrayBuffer();
		strictEqual(response.status, 401);
	});

	test('super user invalidation evicts cached entries', async () => {
		const url = `${ctx.harper.httpURL}/origin/invalidated`;
		const original = await fetch(url);
		const originalBody = await original.text();
		assertCacheStatus(original, 'MISS');
		const cached = await fetch(url);
		await cached.arrayBuffer();
		assertCacheStatus(cached, 'HIT');

		const { username, password } = ctx.harper.admin;
		const invalidation = await fetch(`${ctx.harper.httpURL}/invalidate`, {
			method: 'POST',
			headers: { Authorization: basicAuth(username, password) },
		});
		strictEqual(invalidation.status, 200);
		match(await invalidation.text(), /Cache invalidation complete, deleted \d+ entries/);

		const refetched = await fetch(url);
		assertCacheStatus(refetched, 'MISS');
		notStrictEqual(await refetched.text(), originalBody);
	});
});
