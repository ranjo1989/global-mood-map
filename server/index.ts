import path from 'node:path';
import { RETENTION_HOURS } from '../shared/types';
import { createApp, parseSupportCrypto } from './app';
import { MemoryStore } from './store';
import type { SseHub } from './sse';
import { seedHistory, startLive } from './sim/index';

const PRUNE_EVERY_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// ENV CONTRACT (documented in docs/API.md — keep the two in sync):
//   PORT          listen port                                (default 8787)
//   DATA_DIR      directory holding reports.jsonl            (default ./data)
//   SIM           'on' | 'off' — seed history + live sim     (default on)
//   TRUST_PROXY   Express trust proxy: unset/'' = off,
//                 '1' = first hop, 'true' = all hops
//   GEO_FALLBACK  optional 'lat,lng' when IP geolocation fails
//                 (read lazily by server/geo.ts, not here)
//   SUPPORT_URL   optional donations page URL, surfaced to clients via
//                 /api/meta supportUrl (null when unset)
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT || 8787);
const dataDir = path.resolve(process.env.DATA_DIR || './data');
const dataFile = path.join(dataDir, 'reports.jsonl');
const sim = (process.env.SIM ?? 'on') !== 'off';
const supportUrl = process.env.SUPPORT_URL || null;
const supportCrypto = parseSupportCrypto(process.env.SUPPORT_CRYPTO);

const trustProxyRaw = process.env.TRUST_PROXY ?? '';
let trustProxy: boolean | number | undefined;
if (trustProxyRaw === 'true') trustProxy = true;
else if (/^\d+$/.test(trustProxyRaw)) trustProxy = Number(trustProxyRaw);
// unset / '' / anything else → off (Express default: req.ip = socket peer)

const store = new MemoryStore(dataFile);
const persisted = store.count();

let seeded = 0;
let stopLive: () => void = () => {};
if (sim) {
  seeded = seedHistory(store, { now: Date.now() });
  stopLive = startLive(store);
}

const app = createApp(store, { simulated: sim, trustProxy, supportUrl, supportCrypto });
const server = app.listen(port, () => {
  console.log(
    `Global Mood Map listening on http://localhost:${port} | ` +
      `config: PORT=${port} DATA_DIR=${dataDir} SIM=${sim ? 'on' : 'off'} ` +
      `TRUST_PROXY=${trustProxy === undefined ? 'off' : String(trustProxy)} ` +
      `GEO_FALLBACK=${process.env.GEO_FALLBACK ? 'set' : 'unset'} ` +
      `SUPPORT_URL=${supportUrl ? 'set' : 'unset'} | ` +
      `${store.count()} reports (${persisted} persisted, ${seeded} seeded)`
  );
});

const pruneTimer = setInterval(() => {
  const removed = store.prune(Date.now() - RETENTION_HOURS * 3_600_000);
  if (removed > 0) console.log(`pruned ${removed} reports older than ${RETENTION_HOURS}h`);
}, PRUNE_EVERY_MS);
pruneTimer.unref();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  stopLive();
  clearInterval(pruneTimer);
  // Close SSE streams so server.close() can complete.
  (app.locals.sseHub as SseHub | undefined)?.close();
  server.close(() => process.exit(0));
  // Fallback in case a socket lingers past close.
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
