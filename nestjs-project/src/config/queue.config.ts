import { registerAs } from '@nestjs/config';

/** Redis connection backing the BullMQ queues (phase-03-videos/TD-04). */
export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
}));
