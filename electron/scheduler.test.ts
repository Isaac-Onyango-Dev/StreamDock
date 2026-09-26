import { describe, expect, it } from 'vitest';
import { planStarts, type HostPolicy, type SchedulerInput } from './scheduler';

const OPEN: HostPolicy = { maxConcurrent: 10, minStartSpacingMs: 0 };
const ONE_AT_A_TIME: HostPolicy = { maxConcurrent: 1, minStartSpacingMs: 3_000 };

function input(overrides: Partial<SchedulerInput>): SchedulerInput {
  return {
    queue: [],
    active: [],
    globalLimit: 3,
    lastStartAt: new Map(),
    now: 100_000,
    online: true,
    policyFor: (host) => (host === 'anikoto.cz' ? ONE_AT_A_TIME : OPEN),
    ...overrides,
  };
}

const job = (id: string, host = 'youtube.com') => ({ id, host });

describe('planStarts', () => {
  it('fills free slots in queue order up to the global limit', () => {
    const plan = planStarts(input({ queue: [job('a'), job('b'), job('c'), job('d')], active: ['vimeo.com'] }));
    expect(plan.start).toEqual(['a', 'b']);
    expect(plan.waiting.get('c')).toEqual({ kind: 'global-limit', limit: 3 });
  });

  it('holds a probe host to its own limit while other hosts keep starting', () => {
    const plan = planStarts(input({
      queue: [job('ep2', 'anikoto.cz'), job('yt')],
      active: ['anikoto.cz'],
    }));
    expect(plan.start).toEqual(['yt']);
    expect(plan.waiting.get('ep2')).toEqual({ kind: 'host-limit', host: 'anikoto.cz', limit: 1 });
  });

  it('never starts two jobs for a one-at-a-time host in the same pass', () => {
    const plan = planStarts(input({ queue: [job('ep1', 'anikoto.cz'), job('ep2', 'anikoto.cz')] }));
    expect(plan.start).toEqual(['ep1']);
  });

  it('spaces starts on a host and says when to look again', () => {
    const plan = planStarts(input({
      queue: [job('ep2', 'anikoto.cz')],
      lastStartAt: new Map([['anikoto.cz', 99_000]]),
    }));
    expect(plan.start).toEqual([]);
    expect(plan.waiting.get('ep2')).toEqual({ kind: 'spacing', host: 'anikoto.cz' });
    expect(plan.wakeAt).toBe(102_000);
  });

  it('starts nothing while offline', () => {
    const plan = planStarts(input({ queue: [job('a')], online: false }));
    expect(plan.start).toEqual([]);
    expect(plan.waiting.get('a')).toEqual({ kind: 'offline' });
  });
});
