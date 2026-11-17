import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { Repository } from 'typeorm';
import { InvalidMediaError } from '../media/media.errors';
import { MediaProbeService } from '../media/media-probe.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import type { ProcessVideoJobData } from './video-processing.types';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_URL_TTL_SECONDS,
  videoThumbnailKey,
} from './videos.constants';

/**
 * Consumer of the `video-processing` queue. It is registered only in
 * `WorkerModule`, so the API process stays a pure producer
 * (phase-03-videos/TD-07).
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly media: MediaProbeService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: job.data.videoId },
    });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      // Redelivered job or deleted video: nothing to do, keeps it idempotent.
      return;
    }

    const sourceUrl = await this.storage.presignGetObject(video.source_key, {
      expiresIn: VIDEO_PROCESSING_URL_TTL_SECONDS,
      endpoint: 'internal',
    });

    try {
      const { duration_seconds, metadata } = await this.media.probe(sourceUrl);
      const thumbnail = await this.media.extractThumbnail(
        sourceUrl,
        duration_seconds,
      );
      const thumbnailKey = videoThumbnailKey(video.id);
      await this.storage.putObject(thumbnailKey, thumbnail, 'image/jpeg');

      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.READY,
          duration_seconds,
          metadata,
          thumbnail_key: thumbnailKey,
          processing_error: null,
          processed_at: new Date(),
        },
      );
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        // Retrying cannot fix an undecodable file (phase-03-videos/TD-11).
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  /**
   * Marks the video `failed` only when no retry is left: the job failed with
   * an `UnrecoverableError` or exhausted its attempts (phase-03-videos/TD-11).
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) {
      this.logger.error(
        `Job failed before it could be identified: ${error.message}`,
      );
      return;
    }
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinal =
      error instanceof UnrecoverableError || job.attemptsMade >= maxAttempts;
    if (!isFinal) {
      this.logger.warn(
        `Processing of video ${job.data.videoId} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
      );
      return;
    }

    // Background handler: rethrowing would only produce an unhandled event
    // error, so persistence failures are logged (nestjs-services.md).
    try {
      await this.videoRepository.update(
        { id: job.data.videoId, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          processing_error: error.message,
          processed_at: new Date(),
        },
      );
      this.logger.error(
        `Video ${job.data.videoId} marked as failed: ${error.message}`,
      );
    } catch (persistError) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed`,
        persistError instanceof Error ? persistError.stack : undefined,
      );
    }
  }
}
