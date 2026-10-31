import { ReplayRefusedError, replayDeadLetter } from '../worker/replay.js';
import { parseReplayArgs } from './args.js';
import { createRuntime, reportFatal } from './runtime.js';

async function main(): Promise<number> {
  const args = parseReplayArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(args.usage);
    return 2;
  }
  const rt = await createRuntime();
  try {
    const { replayJobId } = await replayDeadLetter(rt, args.value.jobId);
    console.log(JSON.stringify({ replayed: args.value.jobId, replayJobId }));
    return 0;
  } catch (err) {
    if (err instanceof ReplayRefusedError) {
      rt.logger.warn({ event: 'dead_letter_replay_refused', jobId: args.value.jobId, errorCode: err.code });
      return 3;
    }
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
