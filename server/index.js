import { execFileSync } from 'node:child_process';
import { createApp } from './app.js';
import { getConfig } from './config.js';
import { cleanupOldSandboxes } from './sandbox.js';

try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  console.error('BehindGit needs git on PATH.');
  process.exit(1);
}

const cfg = getConfig();
await cleanupOldSandboxes();

const timer = setInterval(() => {
  cleanupOldSandboxes().catch((error) => {
    console.error('Sandbox cleanup failed:', error.message);
  });
}, 10 * 60 * 1000);
timer.unref();

const app = createApp();
const server = app.listen(cfg.port, cfg.host, () => {
  const shownHost = cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host;
  console.log(`BehindGit listening on http://${shownHost}:${cfg.port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
