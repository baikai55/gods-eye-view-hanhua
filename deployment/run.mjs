import { preview } from 'vite';
import { createGatewayServer } from './gateway.mjs';

const upstreamPort = Number(process.env.GEV_UPSTREAM_PORT || 4174);
const publicPort = Number(process.env.GEV_PORT || 4173);
const publicOrigins = String(process.env.GEV_PUBLIC_ORIGINS || 'https://map.yueming.uk')
  .split(',').map(value => value.trim()).filter(Boolean);

const application = await preview({
  root: '/app',
  configFile: '/app/vite.config.js',
  preview: { host: '127.0.0.1', port: upstreamPort, strictPort: true },
});
const gateway = createGatewayServer({
  upstreamPort, publicOrigins,
  onError: error => console.error('[gateway]', error.message),
});
await new Promise((resolve, reject) => {
  gateway.once('error', reject);
  gateway.listen(publicPort, '0.0.0.0', resolve);
});
console.log(`[gods-eye-view] listening on :${publicPort}; public origins: ${publicOrigins.join(', ')}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 8_000);
  deadline.unref();
  gateway.closeAllConnections();
  await new Promise(resolve => gateway.close(resolve));
  await application.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
