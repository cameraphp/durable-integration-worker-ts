import { afterEach, describe, expect, it } from 'vitest';
import { parseReplayArgs } from '../../src/cli/args.js';
import { ReplayRefusedError, replayDeadLetter } from '../../src/worker/replay.js';
import { cleanupTempDirs, makeHarness, ScriptedAdapter, syntheticEvent } from '../support/harness.js';

afterEach(cleanupTempDirs);

const ID = '44444444-4444-4444-8444-444444444444';

describe('dead-letter replay', () => {
  it('T-RP-01 replay CLI requires --job-id and --confirm-replay', () => {
    expect(parseReplayArgs([])).toMatchObject({ ok: false });
    expect(parseReplayArgs(['--job-id', ID])).toMatchObject({ ok: false });
    expect(parseReplayArgs(['--confirm-replay'])).toMatchObject({ ok: false });
    expect(parseReplayArgs(['--job-id', 'not-a-uuid', '--confirm-replay'])).toMatchObject({ ok: false });
    expect(parseReplayArgs(['--job-id', ID, '--confirm-replay', '--force'])).toMatchObject({ ok: false });
    expect(parseReplayArgs(['--job-id', ID, '--confirm-replay'])).toEqual({ ok: true, value: { jobId: ID } });
  });

  it('T-RP-02 replay creates a linked job, preserves the audit trail and skips completed steps', async () => {
    let deliverFails = true;
    const adapter = new ScriptedAdapter({ deliver: () => (deliverFails ? { kind: 'failure', hint: 'rejected', status: 422 } : { kind: 'success' }) });
    const h = await makeHarness({ adapter });
    const original = (await h.post(syntheticEvent(), 'replay-key-0000000001', 'corr-replay-01')).json<{ jobId: string }>().jobId;
    await h.cycle();
    expect(h.store.get(original)).toMatchObject({ state: 'DEAD_LETTERED', steps: { normalize: 'SUCCEEDED', deliver: 'PENDING' } });

    const deps = { store: h.store, clock: h.clock, config: h.config, logger: h.logs.logger };
    const { replayJobId } = await replayDeadLetter(deps, original);
    deliverFails = false;
    await h.cycle();

    await h.restart();
    expect(h.store.get(original)).toMatchObject({ state: 'DEAD_LETTERED', replayedAs: replayJobId });
    expect(h.store.get(replayJobId)).toMatchObject({ state: 'SUCCEEDED', replayOf: original, correlationId: 'corr-replay-01', attempt: 1 });
    expect(adapter.calls).toEqual({ normalize: 1, deliver: 2 });
    const view = (await h.app.inject({ method: 'GET', url: `/v1/jobs/${replayJobId}` })).json();
    expect(view).toMatchObject({ replayOf: original });
    expect(h.logs.byEvent('dead_letter_replayed')[0]).toMatchObject({ jobId: original, replayJobId, correlationId: 'corr-replay-01' });
  });

  it('T-RP-03 replay refuses unknown, non-dead-lettered and already-replayed jobs', async () => {
    const h = await makeHarness({ adapter: new ScriptedAdapter({ deliver: (c) => (c.event.data.note === 'dlq' ? { kind: 'failure', hint: 'rejected' } : { kind: 'success' }) }) });
    const ok = (await h.post(syntheticEvent(), 'replay-key-0000000002')).json<{ jobId: string }>().jobId;
    const dead = (await h.post(syntheticEvent({ note: 'dlq' }), 'replay-key-0000000003')).json<{ jobId: string }>().jobId;
    await h.cycle();
    const deps = { store: h.store, clock: h.clock, config: h.config, logger: h.logs.logger };
    await expect(replayDeadLetter(deps, ID)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    await expect(replayDeadLetter(deps, ok)).rejects.toMatchObject({ code: 'NOT_DEAD_LETTERED' });
    await replayDeadLetter(deps, dead);
    await expect(replayDeadLetter(deps, dead)).rejects.toBeInstanceOf(ReplayRefusedError);
    await expect(replayDeadLetter(deps, dead)).rejects.toMatchObject({ code: 'ALREADY_REPLAYED' });
  });

  it('T-RP-04 there is no HTTP replay endpoint', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({ method: 'POST', url: `/v1/jobs/${ID}/replay` });
    expect(res.statusCode).toBe(404);
  });
});
