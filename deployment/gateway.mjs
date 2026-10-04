import http from 'node:http';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const PROXY_HEADERS = new Set([
  'forwarded', 'via', 'x-real-ip', 'cf-connecting-ip', 'cf-ray',
  'cf-visitor', 'cdn-loop',
]);

function reply(res, status, error) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({ error }));
}

function parseAuthority(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || /[\s\\/?#@]/.test(raw)) return null;
  try {
    const url = new URL(`http://${raw}`);
    return { host: url.host, hostname: url.hostname, port: url.port };
  } catch { return null; }
}

function validOrigin(value, authority, origins) {
  try {
    const origin = new URL(value);
    if (origin.username || origin.password || origin.pathname !== '/' ||
        origin.search || origin.hash) return false;
    if (['localhost', '127.0.0.1'].includes(authority.hostname)) {
      return origin.origin === `http://${authority.host}`;
    }
    return origins.has(origin.origin) && origin.host === authority.host;
  } catch { return false; }
}

/** A fixed local upstream; only configured public origins can pass the gates. */
export function createGatewayServer({
  upstreamPort = 4174,
  publicOrigins = ['https://map.yueming.uk'],
  onError = () => {},
} = {}) {
  const origins = new Set(publicOrigins.map(value => new URL(value).origin));
  const hosts = new Set(['localhost', '127.0.0.1',
    ...Array.from(origins, value => new URL(value).hostname)]);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const upstreamAuthority = `127.0.0.1:${upstreamPort}`;

  const server = http.createServer((req, res) => {
    const authority = parseAuthority(req.headers.host);
    if (!authority || !hosts.has(authority.hostname)) {
      return reply(res, 403, 'Host is not allowed');
    }
    let path;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw Error();
      const url = new URL(req.url, 'http://gateway.local');
      path = url.pathname;
      for (let i = 0; i < 3; i++) {
        const decoded = decodeURIComponent(path);
        if (decoded === path) break;
        path = decoded;
      }
      if (path.includes('\\')) throw Error();
    } catch { return reply(res, 400, 'Invalid request path'); }

    if (/^\/(?:api\/setup(?:\/|$)|mcp(?:\/|$)|\.env(?:\.|\/|$)|\.git(?:\/|$))/.test(path)) {
      return reply(res, 403, 'This endpoint is not available remotely');
    }
    if (req.headers.origin !== undefined &&
        !validOrigin(req.headers.origin, authority, origins)) {
      return reply(res, 403, 'Cross-origin requests are not accepted');
    }
    if (path.startsWith('/api/')) {
      const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      if (site && !['same-origin', 'none'].includes(site)) {
        return reply(res, 403, 'Cross-site requests are not accepted');
      }
    }
    if (path === '/healthz') {
      if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, 'Method not allowed');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : '{"status":"ok"}');
    }

    // Cloudflared is the only ingress: the host publishes this port on loopback.
    // Validate its public Origin above, then convert it to the fixed local origin.
    const connectionHeaders = new Set(String(req.headers.connection || '')
      .split(',').map(name => name.trim().toLowerCase()));
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_HEADERS.has(name) || PROXY_HEADERS.has(name) ||
          connectionHeaders.has(name) || name.startsWith('x-forwarded-')) continue;
      headers[name] = value;
    }
    headers.host = upstreamAuthority;
    if (req.headers.origin !== undefined) headers.origin = `http://${upstreamAuthority}`;

    const outgoing = http.request({
      hostname: '127.0.0.1', port: upstreamPort, path: req.url,
      method: req.method, headers, agent,
    }, incoming => {
      const responseHeaders = Object.fromEntries(Object.entries(incoming.headers)
        .filter(([name]) => !HOP_HEADERS.has(name)));
      res.writeHead(incoming.statusCode || 502, responseHeaders);
      incoming.pipe(res);
      incoming.on('error', () => res.destroy());
    });
    outgoing.setTimeout(65_000, () => outgoing.destroy(new Error('Upstream timeout')));
    outgoing.on('error', error => {
      onError(error);
      if (!res.headersSent) reply(res, 502, 'Application temporarily unavailable');
      else res.destroy();
    });
    req.on('aborted', () => outgoing.destroy());
    res.on('close', () => { if (!res.writableEnded) outgoing.destroy(); });
    req.pipe(outgoing);
  });
  server.maxConnections = 256;
  server.requestTimeout = 75_000;
  server.headersTimeout = 60_000;
  server.on('close', () => agent.destroy());
  return server;
}
