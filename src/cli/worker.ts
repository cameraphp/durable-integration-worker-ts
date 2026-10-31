import { runWorkerCycle } from '../worker/worker.js';
import { parseWorkerArgs } from './args.js';
import { createRuntime, reportFatal } from './runtime.js';

async function main(): Promise<number> {
  const args = parseWorkerArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(args.usage);
    return 2;
  }
  const rt = await createRuntime();
  try {
    await runWorkerCycle(rt);
    return 0;
  } catch (err) {
    return reportFatal(err, rt.logger);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.exitCode = reportFatal(err);
  },
);
