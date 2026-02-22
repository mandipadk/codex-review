export const RUN_QUEUE_NAME = 'pr-guardian-runs';

export type RunJob = {
  type: 'run_pr';
  runId: number;
};

export type CancelRunJob = {
  type: 'cancel_run';
  runId: number;
  reason?: string;
};

export type ExplainFindingJob = {
  type: 'explain_finding';
  runId: number;
  findingId: string;
};

export type PatchFindingJob = {
  type: 'patch_finding';
  runId: number;
  findingId: string;
};

export type QueueJobPayload = RunJob | CancelRunJob | ExplainFindingJob | PatchFindingJob;

export const queueJobName = (payload: QueueJobPayload): QueueJobPayload['type'] => payload.type;

export const queueJobId = (payload: QueueJobPayload): string => {
  switch (payload.type) {
    case 'run_pr':
      return `run:${payload.runId}`;
    case 'cancel_run':
      return `cancel:${payload.runId}`;
    case 'explain_finding':
      return `explain:${payload.runId}:${payload.findingId}`;
    case 'patch_finding':
      return `patch:${payload.runId}:${payload.findingId}`;
    default:
      return `job:${Date.now()}`;
  }
};
