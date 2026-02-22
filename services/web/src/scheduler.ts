import { Queue } from 'bullmq';

import { queueJobId, queueJobName, QueueJobPayload, RUN_QUEUE_NAME } from '@pr-guardian/common';

export interface RunScheduler {
  enqueue(payload: QueueJobPayload): Promise<void>;
}

export class BullRunScheduler implements RunScheduler {
  private readonly queue: Queue<QueueJobPayload>;

  constructor(redisUrl: string) {
    this.queue = new Queue<QueueJobPayload>(RUN_QUEUE_NAME, {
      connection: connectionFromRedisUrl(redisUrl)
    });
  }

  async enqueue(payload: QueueJobPayload): Promise<void> {
    await this.queue.add(queueJobName(payload), payload, {
      jobId: queueJobId(payload),
      removeOnComplete: 1_000,
      removeOnFail: 1_000
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
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
