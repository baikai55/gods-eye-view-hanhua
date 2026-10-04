import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createGatewayServer } from './gateway.mjs';
import { admitSameSiteRequest } from '../src/localRequestGate.mjs';

async function fixture() {
  const backend = http.createServer((req, res) => {
    const result = admitSameSiteRequest({
      hostHeader: req.headers.host, protocol: 'http:',
      origin: req.headers.origin, secFetchSite: req.headers['sec-fetch-site'],
      proxyHeaders: req.headers,
    });
    res.writeHead(result.ok ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result, headers: req.headers, url: req.url }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const gateway = createGatewayServer({ upstreamPort: backend.address().port });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  return {
    request(path, headers = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: gateway.address().port,
          path, headers: { host: 'map.yueming.uk', ...headers } }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', data => { body += data; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject);
        req.end();
      });
    },
    async close() {
      gateway.closeAllConnections();
      await new Promise(resolve => gateway.close(resolve));
      backend.closeAllConnections();
      await new Promise(resolve => backend.close(resolve));
    },
  };
}

test('Cloudflare HTTPS request passes the original upstream same-site gate', async () => {
  const f = await fixture();
  try {
    const res = await f.request('/api/realtime/token', {
      origin: 'https://map.yueming.uk', 'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.1',
      'cf-connecting-ip': '192.0.2.1', 'cf-ray': 'example',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.ok, true);
    assert.equal(res.body.headers.origin, `http://${res.body.headers.host}`);
    assert.equal(res.body.headers['cf-ray'], undefined);
    assert.equal(res.body.headers['x-forwarded-for'], undefined);
  } finally { await f.close(); }
});

test('foreign and opaque origins remain blocked', async () => {
  const f = await fixture();
  try {
    for (const origin of ['https://evil.example', 'null', 'https://map.yueming.uk/evil']) {
      assert.equal((await f.request('/api/realtime/token', { origin })).status, 403);
    }
  } finally { await f.close(); }
});

test('browser requests from another site cannot spend provider quota', async () => {
  const f = await fixture();
  try {
    for (const site of ['cross-site', 'same-site']) {
      assert.equal((await f.request('/api/google/text-search', { 'sec-fetch-site': site })).status, 403);
    }
  } finally { await f.close(); }
});

test('credential, MCP and secret-file endpoints remain unavailable', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/setup/keys', '/api/setup/status', '/mcp', '/.env', '/.git/config', '/%2eenv']) {
      assert.equal((await f.request(path)).status, 403, path);
    }
  } finally { await f.close(); }
});

test('unconfigured hosts are rejected', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/', { host: 'evil.example' })).status, 403);
  } finally { await f.close(); }
});

test('local health check and anonymous feed requests work', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/healthz', { host: '127.0.0.1' })).body.status, 'ok');
    assert.equal((await f.request('/api/opensky/states/all')).status, 200);
  } finally { await f.close(); }
});
