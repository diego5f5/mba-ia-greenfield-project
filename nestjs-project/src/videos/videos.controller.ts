import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { RequestUploadPartsDto } from './dto/request-upload-parts.dto';
import { UploadPartUrlsResponseDto } from './dto/upload-part-urls-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

const PUBLIC_ID_PARAM = {
  name: 'public_id',
  description: 'URL-facing unique id of the video (11 characters, base64url)',
  example: 'dQw4w9WgXcQ',
} as const;

/** HTTP layer only: every rule lives in `VideosService`. */
@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as `draft` and starts the multipart upload in the object storage. Returns the video `public_id` and the part plan; the file bytes never go through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Video pre-registered as draft',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (missing field, size above 10 GiB, non-video content type, title too long)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createVideo(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    return this.videosService.createVideo(user.sub, dto);
  }

  @Post(':public_id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Get presigned URLs for upload parts',
    description:
      'Issues one presigned `PUT` URL per requested part number. The client uploads each part straight to the storage and keeps the `ETag` header of every response for the completion call.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs, in request order',
    type: UploadPartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, or a part number is greater than the video part count (`INVALID_UPLOAD_PARTS`)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'Video not found or not owned by the caller (`VIDEO_NOT_FOUND`)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is no longer a draft (`UPLOAD_NOT_IN_PROGRESS`)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async requestUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
    @Body() dto: RequestUploadPartsDto,
  ): Promise<UploadPartUrlsResponseDto> {
    return this.videosService.requestUploadPartUrls(
      user.sub,
      publicId,
      dto.part_numbers,
    );
  }

  @Post(':public_id/upload/completion')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Assembles the uploaded parts, checks the final size and moves the video to `processing`, queuing it for background processing. Idempotent: repeating the call on a video that already left `draft` changes nothing and answers 200.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; the video is now processing',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 200,
    description: 'The video had already left draft; current state returned',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, or the storage rejected the parts (`INVALID_UPLOAD_PARTS`); the video stays a draft so the call can be retried',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'Video not found or not owned by the caller (`VIDEO_NOT_FOUND`)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'Uploaded size differs from the declared one (`UPLOAD_SIZE_MISMATCH`); the video is marked failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
    @Body() dto: CompleteUploadDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VideoResponseDto> {
    const { video, transitioned } = await this.videosService.completeUpload(
      user.sub,
      publicId,
      dto.parts,
    );
    // Transport decision only: 202 for the call that started the processing.
    response.status(transitioned ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return video;
  }
}
