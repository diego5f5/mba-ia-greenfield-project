import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors.util';
import {
  InvalidUploadPartsException,
  UploadNotInProgressException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { MultipartUploadRejectedError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { CompletedPartDto } from './dto/complete-upload.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadPartUrlsResponseDto } from './dto/upload-part-urls-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { calculatePartCount } from './upload-plan.util';
import { ProcessVideoJobData } from './video-processing.types';
import {
  PROCESS_VIDEO_JOB,
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_MAX_FILE_SIZE_BYTES,
  VIDEO_PART_SIZE_BYTES,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_TITLE_MAX_LENGTH,
  VIDEO_URL_TTL_SECONDS,
} from './videos.constants';

const PUBLIC_ID_COLUMN = 'public_id';
const UPLOAD_SIZE_MISMATCH_REASON = 'UPLOAD_SIZE_MISMATCH';
const ENQUEUE_FAILED_REASON = 'ENQUEUE_FAILED';

export interface CompleteUploadResult {
  video: VideoResponseDto;
  /** `true` only for the call that moved the video from draft to processing. */
  transitioned: boolean;
}

type NewVideoFields = Pick<
  Video,
  | 'id'
  | 'channel_id'
  | 'title'
  | 'original_file_name'
  | 'content_type'
  | 'file_size_bytes'
  | 'source_key'
  | 'upload_id'
>;

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Pre-registers the video as `draft` and starts the S3 multipart upload
   * (phase-03-videos/TD-06). No video byte goes through the API: the client
   * uploads each part straight to storage with the URLs from
   * `requestUploadPartUrls` (phase-03-videos/TD-05).
   */
  async createVideo(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Every user gets a channel at registration; its absence is a data bug.
      throw new Error(`No channel found for user ${userId}`);
    }

    const id = randomUUID();
    const sourceKey = `videos/${id}/source`;
    const uploadId = await this.storageService.createMultipartUpload(
      sourceKey,
      dto.content_type,
    );

    let video: Video;
    try {
      video = await this.insertWithUniquePublicId({
        id,
        channel_id: channel.id,
        title: dto.title ?? this.defaultTitle(dto.file_name),
        original_file_name: dto.file_name,
        content_type: dto.content_type,
        file_size_bytes: dto.file_size,
        source_key: sourceKey,
        upload_id: uploadId,
      });
    } catch (error) {
      // Compensation: do not leave an orphan multipart upload in storage.
      try {
        await this.storageService.abortMultipartUpload(sourceKey, uploadId);
      } catch (abortError) {
        this.logger.error(
          `Failed to abort multipart upload ${uploadId} for ${sourceKey}`,
          abortError instanceof Error ? abortError.stack : undefined,
        );
      }
      throw error;
    }

    return {
      ...(await this.toResponse(video)),
      upload: {
        part_size: VIDEO_PART_SIZE_BYTES,
        part_count: calculatePartCount(video.file_size_bytes),
      },
    };
  }

  /**
   * Presigns `UploadPart` URLs on demand for the requested part numbers
   * (phase-03-videos/TD-05). Only the owner of a `draft` video may call it.
   */
  async requestUploadPartUrls(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<UploadPartUrlsResponseDto> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new UploadNotInProgressException();
    }

    const partCount = calculatePartCount(video.file_size_bytes);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidUploadPartsException();
    }

    const uploadId = video.upload_id;
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.source_key,
          uploadId,
          partNumber,
          VIDEO_URL_TTL_SECONDS,
        ),
      })),
    );

    return { parts, expires_in: VIDEO_URL_TTL_SECONDS };
  }

  /**
   * Completes the multipart upload, verifies the assembled object and moves
   * the video `draft → processing`, enqueuing the `process-video` job
   * (phase-03-videos/TD-06, TD-04, TD-11).
   *
   * Idempotent: a video that already left `draft` is returned untouched with
   * `transitioned: false` and no storage or queue operation happens.
   */
  async completeUpload(
    userId: string,
    publicId: string,
    parts: CompletedPartDto[],
  ): Promise<CompleteUploadResult> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      return { video: await this.toResponse(video), transitioned: false };
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.source_key,
        video.upload_id,
        parts.map(({ part_number, etag }) => ({
          partNumber: part_number,
          etag,
        })),
      );
    } catch (error) {
      if (!(error instanceof MultipartUploadRejectedError)) {
        throw error;
      }
      // A concurrent completion may have won the race: storage then no longer
      // knows this upload. If so, report the current state instead of failing.
      const current = await this.findOwnedVideo(userId, publicId);
      if (current.status !== VideoStatus.DRAFT) {
        return { video: await this.toResponse(current), transitioned: false };
      }
      throw new InvalidUploadPartsException();
    }

    const assembled = await this.storageService.headObject(video.source_key);
    if (
      !assembled ||
      assembled.contentLength !== video.file_size_bytes ||
      assembled.contentLength > VIDEO_MAX_FILE_SIZE_BYTES
    ) {
      await this.storageService.deleteObject(video.source_key);
      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          processing_error: UPLOAD_SIZE_MISMATCH_REASON,
          upload_id: null,
          processed_at: new Date(),
        },
      );
      throw new UploadSizeMismatchException();
    }

    // Conditional claim: only one caller can move the video out of `draft`.
    const claim = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, upload_id: null },
    );
    if (!claim.affected) {
      const current = await this.videoRepository.findOneByOrFail({
        id: video.id,
      });
      return { video: await this.toResponse(current), transitioned: false };
    }

    await this.enqueueProcessing(video.id);

    const processing = await this.videoRepository.findOneByOrFail({
      id: video.id,
    });
    return { video: await this.toResponse(processing), transitioned: true };
  }

  /**
   * Publishes the job after the status change is committed. `jobId = videoId`
   * makes a repeated enqueue a no-op. If Redis is unreachable the video would
   * stay in `processing` forever, so it is failed with a reason instead.
   */
  private async enqueueProcessing(videoId: string): Promise<void> {
    try {
      await this.videoProcessingQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId },
        { jobId: videoId },
      );
    } catch (error) {
      await this.videoRepository.update(
        { id: videoId },
        {
          status: VideoStatus.FAILED,
          processing_error: `${ENQUEUE_FAILED_REASON}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          processed_at: new Date(),
        },
      );
      throw error;
    }
  }

  /**
   * Ownership rule of phase 03: only the channel that owns the video may act
   * on it; anyone else gets the same `VIDEO_NOT_FOUND` as an unknown id so the
   * existence of other channels' drafts is not revealed.
   */
  private async findOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /**
   * Inserts the draft, generating a fresh `public_id` per attempt. The unique
   * index is the source of truth (phase-03-videos/TD-09): a collision is
   * retried; any other error propagates. There is no enclosing transaction,
   * so a failed insert leaves nothing aborted and no SAVEPOINT is needed.
   */
  private async insertWithUniquePublicId(
    fields: NewVideoFields,
  ): Promise<Video> {
    for (let attempt = 0; attempt < PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      const video = this.videoRepository.create({
        ...fields,
        public_id: generatePublicId(),
        status: VideoStatus.DRAFT,
      });
      try {
        return await this.videoRepository.save(video);
      } catch (error) {
        if (!isPgUniqueViolationOnColumn(error, PUBLIC_ID_COLUMN)) {
          throw error;
        }
      }
    }
    throw new Error(
      `Could not generate a unique public_id after ${PUBLIC_ID_MAX_ATTEMPTS} attempts`,
    );
  }

  /** File name without its extension, capped to the title length. */
  private defaultTitle(fileName: string): string {
    const extensionStart = fileName.lastIndexOf('.');
    const stem =
      extensionStart > 0 ? fileName.slice(0, extensionStart) : fileName;
    return stem.slice(0, VIDEO_TITLE_MAX_LENGTH);
  }

  private async toResponse(video: Video): Promise<VideoResponseDto> {
    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.presignGetObject(video.thumbnail_key, {
          expiresIn: VIDEO_URL_TTL_SECONDS,
          endpoint: 'public',
        })
      : null;

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      original_file_name: video.original_file_name,
      content_type: video.content_type,
      file_size_bytes: video.file_size_bytes,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnail_url: thumbnailUrl,
      processing_error: video.processing_error,
      created_at: video.created_at,
      updated_at: video.updated_at,
    };
  }
}
