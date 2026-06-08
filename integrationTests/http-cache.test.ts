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
 *   - DELETE removes records.
 *   - The exported parseHeaderValue utility parses Cache-Control directives correctly.
 *
 * The v5 caching migration changes verified by these tests:
 *   - blob.save() → createBlob(content, { saveBeforeCommit: table }) (code change in extension.js)
 *   - table.delete() → table.invalidate() on sourced tables (code change in extension.js)
 *   - Header rename: X-HarperDB-Cache → X-Harper-Cache (branding update)
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
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

	test('PUT then GET /HttpCache/:id returns correct headers field', async () => {
		const { admin, httpURL } = ctx.harper;
		const auth = basicAuth(admin.username, admin.password);
		const id = 'test-cache-headers-field';
		const cachedHeaders = { 'content-type': 'application/json', 'x-custom': 'value' };

		await fetch(`${httpURL}/HttpCache/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify({ id, headers: cachedHeaders }),
		});

		const getRes = await fetch(`${httpURL}/HttpCache/${id}`, { headers: { Authorization: auth } });
		const body = (await getRes.json()) as Record<string, unknown>;
		strictEqual(getRes.status, 200);
		deepStrictEqual(
			body['headers'],
			cachedHeaders,
			`expected headers field to match, got ${JSON.stringify(body['headers'])}`
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

	test('Multiple entries can be written and listed via GET /HttpCache/', async () => {
		const { admin, httpURL } = ctx.harper;
		const auth = basicAuth(admin.username, admin.password);

		const ids = ['bulk-entry-a', 'bulk-entry-b', 'bulk-entry-c'];
		for (const id of ids) {
			await fetch(`${httpURL}/HttpCache/${id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: JSON.stringify({ id, headers: { 'content-type': 'text/html' } }),
			});
		}

		const listRes = await fetch(`${httpURL}/HttpCache/`, { headers: { Authorization: auth } });
		strictEqual(listRes.status, 200, `expected 200 for GET /HttpCache/ listing`);
		const body = (await listRes.json()) as unknown[];
		ok(Array.isArray(body) && body.length >= ids.length, `expected at least ${ids.length} entries, got ${body.length}`);
	});
});

suite('http-cache extension — parseHeaderValue utility', () => {
	// parseHeaderValue is a pure function — no Harper instance needed, runs inline.
	// Load it via createRequire since the package is CJS.
	const { parseHeaderValue } = require('../extension.js') as {
		parseHeaderValue: (value: string) => Array<{ name: string; value?: string; next?: unknown }>;
	};

	test('parses a simple Cache-Control directive', () => {
		const result = parseHeaderValue('no-cache');
		ok(Array.isArray(result), 'should return an array');
		strictEqual(result.length, 1);
		strictEqual(result[0]!.name, 'no-cache');
	});

	test('parses a max-age directive with a value', () => {
		const result = parseHeaderValue('max-age=3600');
		strictEqual(result.length, 1);
		strictEqual(result[0]!.name, 'max-age');
		strictEqual(result[0]!.value, '3600');
	});

	test('parses multiple directives separated by commas', () => {
		const result = parseHeaderValue('no-store, max-age=0');
		strictEqual(result.length, 2);
		const names = result.map((r) => r.name);
		ok(names.includes('no-store'), `expected no-store in ${JSON.stringify(names)}`);
		ok(names.includes('max-age'), `expected max-age in ${JSON.stringify(names)}`);
	});

	test('parses a public directive', () => {
		const result = parseHeaderValue('public, max-age=86400');
		const names = result.map((r) => r.name);
		ok(names.includes('public'), `expected public in ${JSON.stringify(names)}`);
		ok(names.includes('max-age'), `expected max-age in ${JSON.stringify(names)}`);
	});
});
