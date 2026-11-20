import { defineConfig, type Plugin } from 'vite';
import { createBridge, optionsFromArgs } from './server/bridge.ts';

/** Runs the serial bridge inside the Vite dev server (single process). */
function de2Bridge(): Plugin {
  return {
    name: 'de2-bridge',
    configureServer(server) {
      const bridge = createBridge(optionsFromArgs([]));
      const s = bridge.status();
      server.config.logger.info(
        `  DE2 bridge: ${s.source} ${s.device} @ ${s.baud} baud`
      );
      server.middlewares.use((req, res, next) => bridge.handle(req, res, next));
      server.httpServer?.on('close', () => bridge.close());
    },
  };
}

export default defineConfig({
  // relative asset paths so the build works under /de2AlteraOptics/ on Pages
  base: './',
  plugins: [de2Bridge()],
  server: { port: 5173, host: 'localhost' },
});
