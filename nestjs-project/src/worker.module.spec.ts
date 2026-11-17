import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { VideoProcessingProcessor } from './videos/video-processing.processor';
import { VIDEO_PROCESSING_QUEUE } from './videos/videos.constants';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should resolve VideoProcessingProcessor with all its dependencies', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    expect(module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)).name).toBe(
      'video-processing',
    );

    await module.close();
  });
});
