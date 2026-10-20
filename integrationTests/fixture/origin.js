let originRequestCount = 0;

// Writes straight to the node response, the way Next.js and the other origins this cache fronts do
server.http(async (request, nextHandler) => {
	if (!request.pathname.startsWith('/origin/')) return nextHandler(request);
	originRequestCount++;
	request._nodeResponse.writeHead(200, { 'Content-Type': 'text/plain' });
	if (request.pathname.startsWith('/origin/large/')) {
		// random so that even brotli output stays above Harper's 8KB inline blob threshold, forcing a file-backed blob
		const randomBody = Buffer.from(crypto.getRandomValues(new Uint8Array(48 * 1024))).toString('base64');
		request._nodeResponse.end(randomBody);
		return;
	}
	request._nodeResponse.end(`origin response ${originRequestCount} for ${request.pathname}`);
});
