// X-HarperDB-Cache is the legacy name, still sent so existing consumers keep working
const CACHE_STATUS_HEADERS = ['X-Harper-Cache', 'X-HarperDB-Cache'];
const CACHE_STATUS_HEADER_KEYS = new Set(CACHE_STATUS_HEADERS.map((name) => name.toLowerCase()));

exports.CACHE_STATUS_HEADERS = CACHE_STATUS_HEADERS;

exports.createCacheBlob = async function (content, cacheTable) {
	const blob = createBlob(content, { saveBeforeCommit: true });
	// Harper before 4.6.9 ignores the saveBeforeCommit option and requires an explicit save
	if (typeof blob.save === 'function' && !blob.saveBeforeCommit) await blob.save(cacheTable);
	return blob;
};

/**
 * Harper 4 returns tracked objects with toJSON(), Harper 5 returns frozen plain records
 */
exports.cachedHeadersToObject = function (rawHeaders) {
	return typeof rawHeaders?.toJSON === 'function' ? rawHeaders.toJSON() : { ...rawHeaders };
};

exports.withoutCacheStatusHeaders = function (headers) {
	const filtered = {};
	for (const name in headers) {
		if (!CACHE_STATUS_HEADER_KEYS.has(name.toLowerCase())) filtered[name] = headers[name];
	}
	return filtered;
};
