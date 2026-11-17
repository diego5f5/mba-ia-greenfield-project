import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

/** Response shape of the media metadata extracted by ffprobe. */
export class VideoMetadataResponseDto {
  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ nullable: true, example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  container_format: string | null;

  @ApiProperty({ nullable: true, example: 4500000 })
  bit_rate: number | null;

  @ApiProperty({ nullable: true, example: 1048576 })
  size_bytes: number | null;
}

export class VideoResponseDto {
  @ApiProperty({
    description: 'URL-facing unique id (11 characters, base64url)',
    example: 'dBjftJeZ4CV',
  })
  public_id: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 'aula.mp4' })
  original_file_name: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ example: 1048576 })
  file_size_bytes: number;

  @ApiProperty({ nullable: true, example: 3.02 })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataResponseDto, nullable: true })
  metadata: VideoMetadataResponseDto | null;

  @ApiProperty({
    nullable: true,
    description:
      'Presigned URL of the thumbnail, present once processing succeeded',
  })
  thumbnail_url: string | null;

  @ApiProperty({ nullable: true, description: 'Set when status is failed' })
  processing_error: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updated_at: Date;
}
