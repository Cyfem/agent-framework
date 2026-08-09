import { createServer } from 'node:net';
import process from 'node:process';
import { setInterval } from 'node:timers';

import { processHandshakeManifest } from './process-handshake-manifest.mjs';

process.once('message', () => {
  const server = createServer();
  server.listen({ port: 0, exclusive: true }, () => {
    process.send(
      { version: '1', type: 'ready', manifest: processHandshakeManifest },
      server,
      (error) => {
        if (error !== null) process.exit(82);
      },
    );
  });
});
setInterval(() => undefined, 1_000);
