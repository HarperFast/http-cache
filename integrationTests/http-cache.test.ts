/**
 * Integration tests for the http-cache extension component.
 *
 * Verifies the v5 caching contract:
 *   - The component starts and Harper initialises the HttpCache table.
 *   - The /invalidate endpoint requires authentication (returns 401 for anonymous requests).
 *   - A superuser POST /invalidate executes cache invalidation (uses `invalidate()`, not
 *     `delete()` — the v5 eviction contract for sourced tables).
 *   - Cache entries written directly to the HttpCache REST endpoint can be retrieved and
 *     respond to conditional requests with a real 304.
 *   - v5 cache validators (ETag/Last-Modified) appear on a HIT, not the priming MISS — we
 *     poll until the cache entry is committed before asserting the validator.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, '..');

// harper's `exports` map only exposes ".", so 'harper/dist/bin/harper.js' is not resolvable
// via require.resolve. Resolve the CLI from the exported main entry and pass it explicitly.
const harperBinPath = resolve(dirname(require.resolve('harper')), 'bin/harper.js');

function basicAuth(username: string, password: string): string {
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// Poll until Harper serves a cache table entry with a validator (ETag or Last-Modified).
// The first write/read cycle for an id may go through an async background commit;
// validators only appear once the entry is committed to the cache table.
async function fetchUntilCached(
	httpURL: string,
	auth: string,
	path: string
): Promise<{ res: Response; etag: string | null; lastModified: string | null }> {
	let last: Response | undefined;
	for (let attempt = 0; attempt < 20; attempt++) {
		const res = await fetch(`${httpURL}${path}`, { headers: { Authorization: auth } });
		await res.arrayBuffer(); // drain body
		const validator = res.headers.get('etag') ?? res.headers.get('last-modified');
		if (res.status === 200 && validator) {
			return { res, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
		}
		last = res;
		await new Promise((r) => setTimeout(r, 50));
	}
	return { res: last!, etag: null, lastModified: null };
}

suite('http-cache extension', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, fixtureDir, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('Harper starts and the HttpCache REST endpoint is accessible', async () => {
		const { admin, httpURL } = ctx.harper;
		const auth = basicAuth(admin.username, admin.password);

		const res = await fetch(`${httpURL}/HttpCache/`, { headers: { Authorization: auth } });
		await res.arrayBuffer();
		ok(res.status < 500, `HttpCache endpoint should not return a server error, got ${res.status}`);
	});

	test('POST /invalidate without auth returns 401 Unauthorized', async () => {
		const { httpURL } = ctx.harper;

		const res = await fetch(`${httpURL}/invalidate`, { method: 'POST' });
		await res.arrayBuffer();
		strictEqual(res.status, 401, `expected 401 for unauthenticated /invalidate, got ${res.status}`);
	});

	test('POST /invalidate with superuser auth executes without error', async () => {
		const { admin, httpURL } = ctx.harper;
		const auth = basicAuth(admin.username, admin.password);

		const res = await fetch(`${httpURL}/invalidate`, {
			method: 'POST',
			headers: { Authorization: auth },
		});
		// The invalidate endpoint streams a text response — drain it.
		await res.text();
		ok(res.status < 400, `superuser POST /invalidate should succeed, got ${res.status}`);
	});

	test('GET /HttpCache/:id returns a written cache entry', async () => {
		const { admin, httpURL } = ctx.harper;
		const auth = basicAuth(admin.username, admin.password);
		const id = 'test-cache-entry-1';

		// Write a cache record directly via the REST API (simulating what the middleware would store).
		const putRes = await fetch(`${httpURL}/HttpCache/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify({
				id,
				headers: { 'content-type': 'text/plain' },
				expiresSWRAt: null,
			}),
		});
		await putRes.arrayBuffer();
		ok([200, 201, 204].includes(putRes.status), `expected successful PUT, got ${putRes.status}`);

		// The entry should now be retrievable.
		const getRes = await fetch(`${httpURL}/HttpCache/${id}`, { headers: { Authorization: auth } });
		const body = (await getRes.json()) as Record<string, unknown>;
		strictEqual(getRes.status, 200, `expected 200 for GET /HttpCache/${id}, got ${getRes.status}`);
		strictEqual(body.id, id, `expected record id to match, got ${body.id}`);
	});

	test('GET /HttpCache/:id returns 304 on conditional request after async commit', async () => {
		const { admin, httpURL } = ctx.harper;
		const auth = basicAuth(admin.username, admin.password);
		const id = 'test-cache-entry-304';

		// Write a cache record.
		await fetch(`${httpURL}/HttpCache/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify({ id, headers: { 'content-type': 'text/plain' } }),
		});

		// Poll until Harper serves the entry with a validator.
		// The async commit means the priming read may not yet have a stored version.
		const { res, etag, lastModified } = await fetchUntilCached(httpURL, auth, `/HttpCache/${id}`);
		strictEqual(res.status, 200, `expected 200 while polling for cached entry ${id}`);
		ok(etag || lastModified, 'a committed cache entry should expose an ETag or Last-Modified validator on a GET');

		// A conditional request with the received validator should return 304.
		const conditionalHeaders: Record<string, string> = { Authorization: auth };
		if (etag) conditionalHeaders['If-None-Match'] = etag;
		else if (lastModified) conditionalHeaders['If-Modified-Since'] = lastModified;

		const conditional = await fetch(`${httpURL}/HttpCache/${id}`, {
			headers: conditionalHeaders,
		});
		await conditional.arrayBuffer();
		strictEqual(
			conditional.status,
			304,
			`a matching conditional request against a committed cache entry should return 304, got ${conditional.status}`
		);
	});

	test('POST /invalidate with x-cache-group for invalid group returns 400', async () => {
		const { admin, httpURL } = ctx.harper;
		const auth = basicAuth(admin.username, admin.password);

		const res = await fetch(`${httpURL}/invalidate`, {
			method: 'POST',
			headers: { 'Authorization': auth, 'x-cache-group': 'nonexistent-group' },
		});
		await res.text();
		strictEqual(res.status, 400, `expected 400 for invalid cache group, got ${res.status}`);
	});
});
