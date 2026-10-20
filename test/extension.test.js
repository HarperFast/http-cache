const { suite, test, before, beforeEach, afterEach, mock } = require('node:test');
const { deepStrictEqual, strictEqual, ok, match, rejects } = require('node:assert/strict');
const { brotliCompressSync, brotliDecompressSync } = require('node:zlib');
const { parseHeaderValue, getCacheHandler, start } = require('../extension.js');

class FakeHttpCache {
	static source;
	static record;
	static lastGet;
	static invalidate = mock.fn(async () => {});
	static searchEntries = [];
	static search = mock.fn(() => FakeHttpCache.searchEntries);
	static primaryStore = {
		getRange: mock.fn(() => [
			{ key: '/a', value: {}, version: 0, expiresAt: 0 },
			{ key: '/b', value: null, version: 0, expiresAt: 0 },
		]),
	};
	static sourcedFrom(source) {
		FakeHttpCache.source = source;
	}
	static async get(id, context) {
		FakeHttpCache.lastGet = { id, context, resource: this };
		return FakeHttpCache.record;
	}
}

function installGlobals() {
	globalThis.databases = { cache: { HttpCache: FakeHttpCache } };
	globalThis.logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };
	globalThis.server = { recordAnalytics: mock.fn(), operation: mock.fn(async () => {}), http: mock.fn() };
}

function createNodeResponse() {
	const headers = Object.create(null);
	return {
		statusCode: 200,
		writableEnded: false,
		chunks: [],
		setHeader(name, value) {
			headers[name.toLowerCase()] = value;
		},
		getHeader(name) {
			return headers[name.toLowerCase()];
		},
		getHeaders() {
			return Object.assign(Object.create(null), headers);
		},
		removeHeader(name) {
			delete headers[name.toLowerCase()];
		},
		writeHead(status, headersArgument) {
			this.statusCode = status;
			this.writtenHead = { status, headers: headersArgument };
			for (const name in headersArgument) this.setHeader(name, headersArgument[name]);
		},
		write(block) {
			this.chunks.push(block);
		},
		end(block) {
			if (block) this.chunks.push(block);
			this.writableEnded = true;
		},
	};
}

function createRequest({ method = 'GET', url = '/page', headers = {}, user } = {}) {
	return {
		method,
		url,
		pathname: url.split('?')[0],
		headers: new Headers(headers),
		user,
		_nodeResponse: createNodeResponse(),
	};
}

function cachedRecord({ headers, content = Buffer.from('cached body'), ageMs = 3000 } = {}) {
	return Object.freeze({
		headers: Object.freeze(headers ?? { 'etag': 'etag-1', 'content-type': 'text/plain' }),
		content,
		getUpdatedTime: () => Date.now() - ageMs,
	});
}

async function readBody(body) {
	let text = '';
	for await (const chunk of body) text += chunk;
	return text;
}

const superUser = { role: { permission: { super_user: true } } };

suite('parseHeaderValue', () => {
	test('parses a single directive', () => {
		deepStrictEqual(parseHeaderValue('no-cache'), [{ name: 'no-cache', next: undefined }]);
	});

	test('parses a directive with a value', () => {
		deepStrictEqual(parseHeaderValue('max-age=3600'), [{ name: 'max-age', value: '3600', next: undefined }]);
	});

	test('parses comma separated directives, trimming whitespace and lowercasing names', () => {
		const parsed = parseHeaderValue('  No-Store ,  Max-Age = 0 ');
		deepStrictEqual(
			parsed.map(({ name, value }) => ({ name, value })),
			[
				{ name: 'no-store', value: undefined },
				{ name: 'max-age', value: '0' },
			]
		);
	});

	test('chains semicolon separated parameters through next', () => {
		const [parsed] = parseHeaderValue('text/html; charset=utf-8; q=0.9');
		strictEqual(parsed.name, 'text/html');
		strictEqual(parsed.next.name, 'charset');
		strictEqual(parsed.next.value, 'utf-8');
		strictEqual(parsed.next.next.name, 'q');
		strictEqual(parsed.next.next.value, '0.9');
		strictEqual(parsed.next.next.next, undefined);
	});

	test('keeps an empty value as undefined', () => {
		deepStrictEqual(parseHeaderValue('max-age='), [{ name: 'max-age', value: '', next: undefined }]);
	});
});

suite('start', () => {
	before(installGlobals);

	test('registers the cache handler with the http server', () => {
		const http = mock.fn();
		start({ server: { http } });
		strictEqual(http.mock.callCount(), 1);
		strictEqual(typeof http.mock.calls[0].arguments[0], 'function');
	});
});

suite('cache handler', () => {
	let handler;
	let nextHandler;

	beforeEach(() => {
		installGlobals();
		FakeHttpCache.record = undefined;
		FakeHttpCache.lastGet = undefined;
		FakeHttpCache.invalidate = mock.fn(async () => {});
		FakeHttpCache.searchEntries = [];
		nextHandler = mock.fn(() => 'next handler response');
		handler = getCacheHandler({ clearRestIntervalMs: 0 });
	});

	afterEach(() => {
		delete globalThis.createBlob;
	});

	suite('cache hit', () => {
		test('serves a Harper 5 frozen record with both cache status headers', async () => {
			FakeHttpCache.record = cachedRecord({
				headers: {
					'etag': 'etag-1',
					'content-type': 'text/plain',
					'content-length': '999',
					'x-harper-cache': 'MISS',
					'x-harperdb-cache': 'MISS',
				},
			});
			const request = createRequest();
			await handler(request, nextHandler);

			const { status, headers } = request._nodeResponse.writtenHead;
			strictEqual(status, 200);
			deepStrictEqual(headers, {
				'etag': 'etag-1',
				'content-type': 'text/plain',
				'X-Harper-Cache': 'HIT',
				'X-HarperDB-Cache': 'HIT',
				'Age': 3,
				'Content-Length': 11,
			});
			strictEqual(request._nodeResponse.chunks.join(''), 'cached body');
			strictEqual(server.recordAnalytics.mock.calls[0].arguments[1], 'http-cache-hit');
			strictEqual(nextHandler.mock.callCount(), 0);
		});

		test('serves a Harper 4 tracked record through toJSON()', async () => {
			FakeHttpCache.record = {
				headers: { toJSON: () => ({ 'etag': 'etag-2', 'X-HarperDB-Cache': 'MISS' }) },
				content: Buffer.from('v4 body'),
				getUpdatedTime: () => Date.now(),
			};
			const request = createRequest();
			await handler(request, nextHandler);

			const { headers } = request._nodeResponse.writtenHead;
			strictEqual(headers['X-Harper-Cache'], 'HIT');
			strictEqual(headers['X-HarperDB-Cache'], 'HIT');
			strictEqual(headers.etag, 'etag-2');
			strictEqual(request._nodeResponse.chunks.join(''), 'v4 body');
		});

		test('returns 304 without a body when If-None-Match matches the ETag', async () => {
			FakeHttpCache.record = cachedRecord();
			const request = createRequest({ headers: { 'If-None-Match': 'etag-1' } });
			await handler(request, nextHandler);

			const { status, headers } = request._nodeResponse.writtenHead;
			strictEqual(status, 304);
			strictEqual(headers['X-Harper-Cache'], 'HIT');
			strictEqual(headers['X-HarperDB-Cache'], 'HIT');
			strictEqual(headers['Content-Length'], undefined);
			deepStrictEqual(request._nodeResponse.chunks, []);
		});

		test('reads blob content into bytes', async () => {
			FakeHttpCache.record = cachedRecord({ content: { bytes: async () => Buffer.from('blob body') } });
			const request = createRequest();
			await handler(request, nextHandler);
			strictEqual(request._nodeResponse.chunks.join(''), 'blob body');
		});

		test('invalidates an unreadable blob and falls through to the origin', async () => {
			FakeHttpCache.record = cachedRecord({
				content: {
					bytes: async () => {
						throw new Error('blob gone');
					},
				},
			});
			const request = createRequest({ url: '/broken' });
			strictEqual(await handler(request, nextHandler), 'next handler response');
			deepStrictEqual(FakeHttpCache.invalidate.mock.calls[0].arguments, ['/broken']);
			strictEqual(logger.warn.mock.callCount(), 1);
			strictEqual(logger.error.mock.callCount(), 0);
		});

		test('still falls through to the origin when invalidating the unreadable blob fails', async () => {
			FakeHttpCache.invalidate = mock.fn(async () => {
				throw new Error('invalidate failed');
			});
			FakeHttpCache.record = cachedRecord({
				content: {
					bytes: async () => {
						throw new Error('blob gone');
					},
				},
			});
			strictEqual(await handler(createRequest(), nextHandler), 'next handler response');
			strictEqual(logger.error.mock.callCount(), 1);
		});

		test('decompresses brotli content for a client without Accept-Encoding', async () => {
			FakeHttpCache.record = cachedRecord({
				headers: { 'etag': 'etag-1', 'content-encoding': 'br' },
				content: brotliCompressSync(Buffer.from('compressed body')),
			});
			const request = createRequest();
			await handler(request, nextHandler);

			const { headers } = request._nodeResponse.writtenHead;
			strictEqual(headers['content-encoding'], undefined);
			strictEqual(request._nodeResponse.chunks.join(''), 'compressed body');
		});

		test('keeps brotli content for a client that accepts it', async () => {
			const compressed = brotliCompressSync(Buffer.from('compressed body'));
			FakeHttpCache.record = cachedRecord({ headers: { 'content-encoding': 'br' }, content: compressed });
			const request = createRequest({ headers: { 'Accept-Encoding': 'gzip, br' } });
			await handler(request, nextHandler);

			strictEqual(request._nodeResponse.writtenHead.headers['content-encoding'], 'br');
			deepStrictEqual(request._nodeResponse.chunks[0], compressed);
		});

		test('rejects when brotli content is corrupt', async () => {
			FakeHttpCache.record = cachedRecord({
				headers: { 'content-encoding': 'br' },
				content: Buffer.from('not brotli'),
			});
			await rejects(handler(createRequest(), nextHandler));
		});

		test('leaves the response alone when the origin already wrote it', async () => {
			const request = createRequest();
			request._nodeResponse.writableEnded = true;
			await handler(request, nextHandler);
			strictEqual(request._nodeResponse.writtenHead, undefined);
		});
	});

	suite('cache lookup', () => {
		test('uses the URL as the key and the request as the context', async () => {
			const request = createRequest({ url: '/path?query=1' });
			request._nodeResponse.writableEnded = true;
			await handler(request, nextHandler);
			strictEqual(FakeHttpCache.lastGet.id, '/path?query=1');
			strictEqual(FakeHttpCache.lastGet.context, request);
			strictEqual(request.cacheNextHandler, nextHandler);
		});

		test('prefers an explicit cacheKey', async () => {
			const request = createRequest();
			request.cacheKey = 'custom-key';
			request._nodeResponse.writableEnded = true;
			await handler(request, nextHandler);
			strictEqual(FakeHttpCache.lastGet.id, 'custom-key');
		});

		test('hashes keys longer than the key overflow length', async () => {
			const request = createRequest({ url: '/' + 'a'.repeat(1500) });
			request._nodeResponse.writableEnded = true;
			await handler(request, nextHandler);
			match(FakeHttpCache.lastGet.id, /^\/a{999}:[0-9a-f]{32}$/);
		});

		test('looks entries up through a resource that decodes paths and allows stale-while-revalidate', async () => {
			const request = createRequest();
			request._nodeResponse.writableEnded = true;
			await handler(request, nextHandler);
			const resource = FakeHttpCache.lastGet.resource;
			strictEqual(resource.parsePath('/a%20b'), '/a b');
			const instance = new resource();
			strictEqual(instance.allowStaleWhileRevalidate({ value: { expiresSWRAt: Date.now() + 60_000 } }), true);
			strictEqual(instance.allowStaleWhileRevalidate({ value: { expiresSWRAt: Date.now() - 1 } }), false);
			strictEqual(instance.allowStaleWhileRevalidate({ value: null }), false);
		});

		test('caps maxAgeSeconds at the scheduled full cache clear', async () => {
			handler = getCacheHandler({ scheduledFullCacheClearTime: new Date().getUTCHours() + 0.5 });
			const request = createRequest();
			request.maxAgeSeconds = 2 * 86400;
			request._nodeResponse.writableEnded = true;
			await handler(request, nextHandler);
			ok(request.maxAgeSeconds > 0 && request.maxAgeSeconds <= 86400, `got ${request.maxAgeSeconds}`);
		});

		test('passes non-GET requests straight to the next handler', async () => {
			strictEqual(await handler(createRequest({ method: 'POST', url: '/form' }), nextHandler), 'next handler response');
			strictEqual(FakeHttpCache.lastGet, undefined);
		});
	});

	suite('/invalidate', () => {
		test('rejects a request without a super user', async () => {
			await rejects(handler(createRequest({ method: 'POST', url: '/invalidate' }), nextHandler), {
				statusCode: 401,
			});
			await rejects(
				handler(
					createRequest({
						method: 'POST',
						url: '/invalidate',
						user: { role: { permission: { super_user: false } } },
					}),
					nextHandler
				),
				{ statusCode: 401 }
			);
		});

		test('rejects an unknown cache group', async () => {
			const request = createRequest({
				method: 'POST',
				url: '/invalidate',
				user: superUser,
				headers: { 'x-cache-group': 'unknown' },
			});
			await rejects(handler(request, nextHandler), { statusCode: 400, message: /Invalid cache group/ });
		});

		test('POST invalidates every cached entry and reports completion', async () => {
			FakeHttpCache.searchEntries = [{ id: '/one' }, { id: '/two' }];
			const response = await handler(
				createRequest({ method: 'POST', url: '/invalidate', user: superUser }),
				nextHandler
			);
			strictEqual(response.status, 200);
			const body = await readBody(response.body);
			match(body, /^Invalidating cache\.\.\.\n/);
			match(body, /Cache invalidation complete, deleted 2 entries\n$/);
			deepStrictEqual(
				FakeHttpCache.invalidate.mock.calls.map((call) => call.arguments[0]),
				['/one', '/two']
			);
			deepStrictEqual(FakeHttpCache.search.mock.calls.at(-1).arguments, [
				[],
				{ onlyIfCached: true, noCacheStore: true },
			]);
		});

		test('POST passes a query string through as the search query', async () => {
			await readBody(
				(await handler(createRequest({ method: 'POST', url: '/invalidate?x=1', user: superUser }), nextHandler)).body
			);
			deepStrictEqual(FakeHttpCache.search.mock.calls.at(-1).arguments[0], { url: '?x=1' });
		});

		test('POST reports a failed invalidation instead of hanging', async () => {
			FakeHttpCache.searchEntries = [{ id: '/one' }];
			FakeHttpCache.invalidate = mock.fn(async () => {
				throw new Error('disk full');
			});
			const response = await handler(
				createRequest({ method: 'POST', url: '/invalidate', user: superUser }),
				nextHandler
			);
			const body = await readBody(response.body);
			match(body, /Cache invalidation failed after 1 entries: disk full\n$/);
			strictEqual(logger.error.mock.callCount(), 1);
		});

		test('GET lists cached entries', async () => {
			const response = await handler(
				createRequest({ method: 'GET', url: '/invalidate?key=/a', user: superUser }),
				nextHandler
			);
			strictEqual(response.status, 200);
			match(response.body, /^id: \/a\nexists: true/);
			match(response.body, /id: \/b\nexists: false/);
			strictEqual(FakeHttpCache.primaryStore.getRange.mock.calls.at(-1).arguments[0].start, '/a');
		});
	});
});

suite('cache source', () => {
	let source;

	beforeEach(() => {
		installGlobals();
		getCacheHandler({});
		source = FakeHttpCache.source;
	});

	afterEach(() => {
		delete globalThis.createBlob;
	});

	function sourceRequest(originHandler, options) {
		const request = createRequest(options);
		request.startTime = 0;
		request.cacheNextHandler = originHandler;
		return request;
	}

	test('marks a direct-write origin response as a MISS and stores it without the status headers', async () => {
		const request = sourceRequest((request) => {
			request._nodeResponse.setHeader('X-HarperDB-Cache', 'stale');
			request._nodeResponse.writeHead(200, { 'Content-Type': 'text/plain', 'Connection': 'keep-alive' });
			request._nodeResponse.write('origin ');
			request._nodeResponse.end('body');
		});
		const context = { requestContext: request };
		const entry = await source.get('/page', context);

		strictEqual(request._nodeResponse.getHeader('X-Harper-Cache'), 'MISS');
		strictEqual(request._nodeResponse.getHeader('X-HarperDB-Cache'), 'MISS');
		strictEqual(request._nodeResponse.chunks.join(''), 'origin body');
		strictEqual(entry.id, '/page');
		strictEqual(entry.headers['content-type'], 'text/plain');
		strictEqual(entry.headers['x-harper-cache'], undefined);
		strictEqual(entry.headers['x-harperdb-cache'], undefined);
		strictEqual(entry.headers.connection, undefined);
		ok(entry.headers.etag, 'an ETag is generated for responses without one');
		strictEqual(entry.content.toString(), 'origin body');
		strictEqual(server.recordAnalytics.mock.calls[0].arguments[1], 'http-cache-miss');
	});

	test('stores the content as a blob when createBlob is available', async () => {
		globalThis.createBlob = mock.fn((content, options) => ({ content, options, saveBeforeCommit: true }));
		const request = sourceRequest((request) => {
			request._nodeResponse.writeHead(200, {});
			request._nodeResponse.end('blob body');
		});
		const entry = await source.get('/page', { requestContext: request });
		strictEqual(entry.content.content.toString(), 'blob body');
		deepStrictEqual(entry.content.options, { saveBeforeCommit: true });
	});

	test('accepts writeHead headers as an array of pairs', async () => {
		const request = sourceRequest((request) => {
			request._nodeResponse.writeHead(200, [['content-type', 'text/html']]);
			request._nodeResponse.end('<p></p>');
		});
		await source.get('/page', { requestContext: request });
		deepStrictEqual(request._nodeResponse.writtenHead.headers, { 'content-type': 'text/html' });
	});

	test('compresses with brotli for a client that accepts it', async () => {
		const request = sourceRequest(
			(request) => {
				request._nodeResponse.setHeader('Content-Type', 'application/json');
				request._nodeResponse.setHeader('Content-Length', '13');
				request._nodeResponse.writeHead(200, {});
				request._nodeResponse.end('{"a":"value"}');
			},
			{ headers: { 'Accept-Encoding': 'gzip, br' } }
		);
		const entry = await source.get('/page', { requestContext: request });
		strictEqual(request.headers.get('Accept-Encoding'), 'br');
		strictEqual(entry.headers['content-encoding'], 'br');
		strictEqual(entry.headers['content-length'], undefined);
		strictEqual(brotliDecompressSync(entry.content).toString(), '{"a":"value"}');
	});

	test('drops an Accept-Encoding without brotli so the origin responds uncompressed', async () => {
		const request = sourceRequest(
			(request) => {
				request._nodeResponse.writeHead(200, {});
				request._nodeResponse.end('plain');
			},
			{ headers: { 'Accept-Encoding': 'gzip' } }
		);
		const entry = await source.get('/page', { requestContext: request });
		strictEqual(request.headers.get('Accept-Encoding'), null);
		strictEqual(entry.content.toString(), 'plain');
	});

	test('does not store a non-200 direct-write response', async () => {
		const request = sourceRequest((request) => {
			request._nodeResponse.statusCode = 404;
			request._nodeResponse.end('missing');
		});
		const context = { requestContext: request };
		await source.get('/page', context);
		strictEqual(context.noCacheStore, true);
	});

	test('pipes a ReadableStream body through the encoder without a prior writeHead', async () => {
		const request = sourceRequest(
			(request) => {
				request._nodeResponse.end(
					new ReadableStream({
						start(controller) {
							controller.enqueue(Buffer.from('streamed'));
							controller.close();
						},
					})
				);
			},
			{ headers: { 'Accept-Encoding': 'br' } }
		);
		const entry = await source.get('/stream', { requestContext: request });
		strictEqual(entry.id, '/stream');
		strictEqual(entry.headers['content-encoding'], 'br');
		strictEqual(entry.headers['x-harper-cache'], undefined);
	});

	test('applies maxAgeSeconds and staleWhileRevalidateSeconds from the request', async () => {
		const request = sourceRequest((request) => {
			request._nodeResponse.writeHead(200, {});
			request._nodeResponse.end('body');
		});
		request.maxAgeSeconds = 60;
		request.staleWhileRevalidateSeconds = 30;
		const context = { requestContext: request };
		const before = Date.now();
		const entry = await source.get('/page', context);
		ok(context.expiresAt >= before + 60_000 && context.expiresAt <= Date.now() + 60_000);
		strictEqual(entry.expiresSWRAt, context.expiresAt + 30_000);
	});

	test('resolves nothing when there is no origin handler', async () => {
		const request = sourceRequest(undefined);
		strictEqual(await source.get('/page', { requestContext: request }), undefined);
	});

	suite('returned responses', () => {
		function originResponse({ status = 200, headers = {}, body = Buffer.from('returned body') } = {}) {
			return { status, headers: new Headers(headers), body };
		}

		test('stores a returned response without the status headers and applies max-age', async () => {
			const request = sourceRequest(() =>
				originResponse({
					headers: {
						'cache-control': 'public, max-age=120',
						'etag': '"origin"',
						'x-harper-cache': 'HIT',
						'X-HarperDB-Cache': 'HIT',
					},
				})
			);
			const context = { requestContext: request };
			const entry = await source.get('/page', context);
			deepStrictEqual(entry.headers, { 'cache-control': 'public, max-age=120', 'etag': '"origin"' });
			strictEqual(entry.content.toString(), 'returned body');
			ok(context.expiresAt > Date.now() + 100_000);
		});

		test('resolves an asynchronously returned response', async () => {
			const request = sourceRequest(async () => originResponse());
			const entry = await source.get('/page', { requestContext: request });
			ok(entry.headers.ETag, 'an ETag is generated for responses without a validator');
			strictEqual(entry.content.toString(), 'returned body');
		});

		test('honors no-store and no-cache', async () => {
			const request = sourceRequest(() => originResponse({ headers: { 'cache-control': 'no-store, no-cache' } }));
			const context = { requestContext: request };
			await source.get('/page', context);
			strictEqual(context.noCacheStore, true);
			strictEqual(context.noCache, true);
		});

		test('does not store a non-200 returned response', async () => {
			const request = sourceRequest(() => originResponse({ status: 500, headers: { 'Last-Modified': 'yesterday' } }));
			const context = { requestContext: request };
			const entry = await source.get('/page', context);
			strictEqual(context.noCacheStore, true);
			strictEqual(entry.headers.ETag, undefined);
		});

		test('stores returned content as a blob when createBlob is available', async () => {
			globalThis.createBlob = mock.fn((content) => ({ content, saveBeforeCommit: true }));
			const request = sourceRequest(() => originResponse());
			const entry = await source.get('/page', { requestContext: request });
			strictEqual(entry.content.content.toString(), 'returned body');
		});
	});
});

suite('additional cache database groups', () => {
	test('creates a missing group table and sources it', async () => {
		installGlobals();
		let createdTable;
		server.operation = mock.fn(async (operation) => {
			createdTable = operation;
			databases.api = { HttpCache: FakeHttpCache };
		});
		databases.api = {};
		getCacheHandler({ additionalCacheDatabaseGroups: ['api'] });
		await new Promise((resolve) => setImmediate(resolve));
		strictEqual(createdTable.operation, 'create_table');
		strictEqual(createdTable.database, 'api');
		strictEqual(createdTable.table, 'HttpCache');
		ok(logger.info.mock.calls.some((call) => call.arguments[0] === 'Establishing cache source for database: api'));
	});
});
