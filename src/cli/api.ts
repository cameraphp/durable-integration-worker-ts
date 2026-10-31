import { buildApp } from '../api/app.js';
import { createRuntime, reportFatal } from './runtime.js';

async function main(): Promise<void> {
  const rt = await createRuntime();
  const app = buildApp({ store: rt.store, config: rt.config, clock: rt.clock, logger: rt.logger });
  await app.listen({ host: rt.config.host, port: rt.config.port });
  rt.logger.info({ event: 'api_listening', host: rt.config.host, port: rt.config.port });
  const shutdown = (signal: string) => {
    rt.logger.info({ event: 'api_shutdown', signal });
    void app.close().then(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.exitCode = reportFatal(err);
});
