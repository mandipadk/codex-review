import { Job, Worker } from 'bullmq';

import { QueueJobPayload, RUN_QUEUE_NAME } from '@pr-guardian/common';

import { RunOrchestrator } from './orchestrator.js';

export interface WorkerRuntime {
  worker: Worker<QueueJobPayload>;
}

export function startRunWorker(params: {
  redisUrl: string;
  concurrency: number;
  orchestrator: RunOrchestrator;
}): WorkerRuntime {
  const worker = new Worker<QueueJobPayload>(
    RUN_QUEUE_NAME,
    async (job: Job<QueueJobPayload>) => {
      await params.orchestrator.handleJob(job.data);
    },
    {
      connection: connectionFromRedisUrl(params.redisUrl),
      concurrency: params.concurrency
    }
  );

  worker.on('failed', (job, error) => {
    console.error('Worker job failed', { jobId: job?.id, name: job?.name, error: error.message });
  });

  worker.on('completed', (job) => {
    console.log('Worker job completed', { jobId: job.id, name: job.name });
  });

  return {
    worker
  };
}

function connectionFromRedisUrl(redisUrl: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
} {
  const parsed = new URL(redisUrl);
  const db = parsed.pathname ? Number(parsed.pathname.replace('/', '')) : undefined;

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isNaN(db) ? undefined : db,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null
  };
}
