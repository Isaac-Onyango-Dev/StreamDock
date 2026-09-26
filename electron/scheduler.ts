// Role: the one decision about which queued downloads may start now.
//
// Admission used to be written four times: enqueue() and drainQueue() each had
// their own per-host rule (checking different URL fields, so a resolved anime
// job stopped counting against its own host), and resume()/retry() checked the
// global limit only. Every path now asks this function, and it is pure — no
// timers, no Electron, no engine state — so the rules are testable on their own.

export interface HostPolicy {
  /** Most downloads from this host running at once. */
  maxConcurrent: number;
  /** Least time between two starts on this host. */
  minStartSpacingMs: number;
}

export interface QueuedJob {
  id: string;
  /** Hostname the job was queued for (the page, never a resolved CDN URL). */
  host: string;
}

export interface SchedulerInput {
  /** Queued jobs in the order they should start. */
  queue: QueuedJob[];
  /** Hosts of every job currently holding a slot (resolving or running). */
  active: string[];
  globalLimit: number;
  /** When each host last had a job started. */
  lastStartAt: ReadonlyMap<string, number>;
  now: number;
  /** False while the engine believes the network is down. */
  online: boolean;
  policyFor: (host: string) => HostPolicy;
}

export type WaitReason =
  | { kind: 'offline' }
  | { kind: 'global-limit'; limit: number }
  | { kind: 'host-limit'; host: string; limit: number }
  | { kind: 'spacing'; host: string };

export interface SchedulerPlan {
  /** Jobs to start now, in order. */
  start: string[];
  /** Why each job that is not starting is waiting. */
  waiting: Map<string, WaitReason>;
  /** When spacing next lets something start, if that is the only thing in the way. */
  wakeAt?: number;
}

export function planStarts(input: SchedulerInput): SchedulerPlan {
  const start: string[] = [];
  const waiting = new Map<string, WaitReason>();
  const running = new Map<string, number>();
  for (const host of input.active) running.set(host, (running.get(host) ?? 0) + 1);
  const startedAt = new Map(input.lastStartAt);
  let total = input.active.length;
  let wakeAt: number | undefined;

  for (const job of input.queue) {
    if (!input.online) {
      waiting.set(job.id, { kind: 'offline' });
      continue;
    }
    if (total >= input.globalLimit) {
      waiting.set(job.id, { kind: 'global-limit', limit: input.globalLimit });
      continue;
    }
    const policy = input.policyFor(job.host);
    if ((running.get(job.host) ?? 0) >= policy.maxConcurrent) {
      waiting.set(job.id, { kind: 'host-limit', host: job.host, limit: policy.maxConcurrent });
      continue;
    }
    const earliest = (startedAt.get(job.host) ?? -Infinity) + policy.minStartSpacingMs;
    if (input.now < earliest) {
      waiting.set(job.id, { kind: 'spacing', host: job.host });
      wakeAt = Math.min(wakeAt ?? earliest, earliest);
      continue;
    }
    start.push(job.id);
    running.set(job.host, (running.get(job.host) ?? 0) + 1);
    startedAt.set(job.host, input.now);
    total += 1;
  }

  return { start, waiting, wakeAt };
}

/** The sentence a queued row shows for why it has not started. */
export function describeWait(reason: WaitReason): string {
  switch (reason.kind) {
    case 'offline':
      return 'Waiting for the network to come back';
    case 'global-limit':
      return `Waiting for a free slot (${reason.limit} at a time)`;
    case 'host-limit':
      return `Waiting — ${reason.host} allows ${reason.limit} download${reason.limit === 1 ? '' : 's'} at a time`;
    case 'spacing':
      return `Starting shortly — spacing requests to ${reason.host}`;
  }
}
