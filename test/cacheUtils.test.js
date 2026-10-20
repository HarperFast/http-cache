const { suite, test, afterEach, mock } = require('node:test');
const { deepStrictEqual, strictEqual, ok } = require('node:assert/strict');
const {
	CACHE_STATUS_HEADERS,
	createCacheBlob,
	cachedHeadersToObject,
	withoutCacheStatusHeaders,
} = require('../cacheUtils.js');

suite('CACHE_STATUS_HEADERS', () => {
	test('sends the current and the legacy header name', () => {
		deepStrictEqual(CACHE_STATUS_HEADERS, ['X-Harper-Cache', 'X-HarperDB-Cache']);
	});
});

suite('createCacheBlob', () => {
	const cacheTable = { name: 'HttpCache' };

	afterEach(() => {
		delete globalThis.createBlob;
	});

	function stubCreateBlob(blob) {
		globalThis.createBlob = mock.fn((content, options) => Object.assign(blob, { content, options }));
		return globalThis.createBlob;
	}

	test('asks Harper to save the blob before commit', async () => {
		const createBlob = stubCreateBlob({});
		const blob = await createCacheBlob(Buffer.from('body'), cacheTable);
		strictEqual(createBlob.mock.callCount(), 1);
		deepStrictEqual(createBlob.mock.calls[0].arguments, [Buffer.from('body'), { saveBeforeCommit: true }]);
		strictEqual(blob.content.toString(), 'body');
	});

	test('does not call save() when the blob has none (Harper 5)', async () => {
		stubCreateBlob({ saveBeforeCommit: true });
		const blob = await createCacheBlob(Buffer.from('body'), cacheTable);
		strictEqual(blob.saveBeforeCommit, true);
	});

	test('does not call the deprecated save() when saveBeforeCommit was honored (Harper 4.6.9+)', async () => {
		const save = mock.fn(async () => {});
		stubCreateBlob({ saveBeforeCommit: true, save });
		await createCacheBlob(Buffer.from('body'), cacheTable);
		strictEqual(save.mock.callCount(), 0);
	});

	test('saves to the cache table when saveBeforeCommit was ignored (Harper before 4.6.9)', async () => {
		let saved = false;
		const save = mock.fn(async () => {
			await new Promise((resolve) => setImmediate(resolve));
			saved = true;
		});
		const stubbed = { save };
		stubCreateBlob(stubbed);
		const blob = await createCacheBlob(Buffer.from('body'), cacheTable);
		strictEqual(blob, stubbed);
		strictEqual(save.mock.callCount(), 1);
		deepStrictEqual(save.mock.calls[0].arguments, [cacheTable]);
		ok(saved, 'the save should be awaited before the blob is returned');
	});
});

suite('cachedHeadersToObject', () => {
	test('uses toJSON() on Harper 4 tracked objects', () => {
		const tracked = { toJSON: () => ({ 'content-type': 'text/plain' }) };
		deepStrictEqual(cachedHeadersToObject(tracked), { 'content-type': 'text/plain' });
	});

	test('copies Harper 5 frozen plain records into a mutable object', () => {
		const frozen = Object.freeze({ 'content-type': 'text/plain' });
		const headers = cachedHeadersToObject(frozen);
		deepStrictEqual(headers, { 'content-type': 'text/plain' });
		headers.age = 1;
		strictEqual(Object.isFrozen(headers), false);
		strictEqual(frozen.age, undefined);
	});

	test('returns an empty object for missing headers', () => {
		deepStrictEqual(cachedHeadersToObject(undefined), {});
		deepStrictEqual(cachedHeadersToObject(null), {});
	});
});

suite('withoutCacheStatusHeaders', () => {
	test('strips both cache status headers in any case', () => {
		const headers = {
			'x-harper-cache': 'MISS',
			'X-HARPERDB-CACHE': 'MISS',
			'X-Harper-Cache': 'HIT',
			'x-harperdb-cache': 'HIT',
			'content-type': 'text/plain',
			'etag': 'abc',
		};
		deepStrictEqual(withoutCacheStatusHeaders(headers), { 'content-type': 'text/plain', 'etag': 'abc' });
	});

	test('does not mutate its input', () => {
		const headers = Object.freeze({ 'x-harper-cache': 'MISS', 'etag': 'abc' });
		withoutCacheStatusHeaders(headers);
		deepStrictEqual(headers, { 'x-harper-cache': 'MISS', 'etag': 'abc' });
	});

	test('accepts the null-prototype object from getHeaders()', () => {
		const headers = Object.create(null);
		headers['x-harper-cache'] = 'MISS';
		headers['content-length'] = '4';
		deepStrictEqual(withoutCacheStatusHeaders(headers), { 'content-length': '4' });
	});
});
