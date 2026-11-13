import { buildApp } from './build.js';

// Self-hosted entry (also fine for a VM or container). Requires DATABASE_URL.
const { app, config, db } = await buildApp();

// Bind to loopback only; put a TLS-terminating reverse proxy in front if you expose it.
const server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'Stock Beat listening', host: config.host, port: config.port }));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  });
}
