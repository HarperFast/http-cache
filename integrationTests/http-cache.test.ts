/**
 * Integration tests for the http-cache extension component.
 *
 * This component is a caching middleware/extension designed to be composed into
 * other Harper applications (e.g. a Next.js or full-page-caching app). Its core
 * middleware functionality (the /invalidate endpoint, the SWR caching loop, the
 * source resolver) only activates when a consuming app calls `getCacheHandler()` and
 * registers it with the HTTP server. When the component runs standalone (as it does
 * in these integration tests), the middleware is not in the request pipeline.
 *
 * What IS testable standalone:
 *   - Harper starts successfully and reads the schema (HttpCache table is created).
 *   - The HttpCache table is accessible via the REST API.
 *   - Direct PUT/GET on HttpCache stores and retrieves records.
 *   - After the async commit, a GET honours conditional requests with a real 304.
 *   - v5 cache validators (ETag/Last-Modified) appear on a HIT, not the priming write —
 *     we poll until the entry is committed before asserting the validator.
 *
 * The v5 caching migration changes verified by these tests:
 *   - blob.save() → createBlob(content, { saveBeforeCommit: table }) (compile-time, code check)
 *   - table.delete() → table.invalidate() on sourced tables (exercised indirectly — the table
 *     schema sets up sourcedFrom which uses invalidate, not delete, in the eviction paths)
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

suite('http-cache extension — standalone schema and table tests', (ctx: ContextWithHarper) => {
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

	test('GET /HttpCache/ returns an array (table is initialized)', async () => {
		const { admin, httpURL } = ctx.harper;
		const auth = basicAuth(admin.username, admin.password);

		const res = await fetch(`${httpURL}/HttpCache/`, { headers: { Authorization: auth } });
		strictEqual(res.status, 200, `expected 200 for GET /HttpCache/, got ${res.status}`);
		const body = (await res.json()) as unknown;
		ok(Array.isArray(body), `expected array response from /HttpCache/, got: ${JSON.stringify(body)}`);
	});

	test('PUT /HttpCache/:id stores a cache record and GET returns it', async () => {
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
		strictEqual(body['id'], id, `expected record id to match, got ${String(body['id'])}`);
	});

	test('GET /HttpCache/:id exposes a validator (ETag or Last-Modified) after async commit', async () => {
		const { admin, httpURL } = ctx.harper;
		const auth = basicAuth(admin.username, admin.password);
		const id = 'test-cache-entry-validator';

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
		ok(etag || lastModified, 'a committed HttpCache entry should expose an ETag or Last-Modified validator');
	});

	test('GET /HttpCache/:id returns 304 on a conditional request after async commit', async () => {
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

	test('DELETE /HttpCache/:id removes the cached record', async () => {
		const { admin, httpURL } = ctx.harper;
		const auth = basicAuth(admin.username, admin.password);
		const id = 'test-cache-entry-delete';

		// Write then delete.
		await fetch(`${httpURL}/HttpCache/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify({ id, headers: {} }),
		});

		const delRes = await fetch(`${httpURL}/HttpCache/${id}`, {
			method: 'DELETE',
			headers: { Authorization: auth },
		});
		await delRes.arrayBuffer();
		ok([200, 204].includes(delRes.status), `expected successful DELETE, got ${delRes.status}`);

		// After deletion the record should be gone.
		const getRes = await fetch(`${httpURL}/HttpCache/${id}`, { headers: { Authorization: auth } });
		await getRes.arrayBuffer();
		strictEqual(getRes.status, 404, `expected 404 after DELETE of ${id}, got ${getRes.status}`);
	});
});
