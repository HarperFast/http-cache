let originRequestCount = 0;

// Writes straight to the node response, the way Next.js and the other origins this cache fronts do
server.http(async (request, nextHandler) => {
	if (!request.pathname.startsWith('/origin/')) return nextHandler(request);
	originRequestCount++;
	request._nodeResponse.writeHead(200, { 'Content-Type': 'text/plain' });
	request._nodeResponse.end(`origin response ${originRequestCount} for ${request.pathname}`);
});
