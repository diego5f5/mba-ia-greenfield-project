import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  VIDEO_CONTENT_TYPE_PATTERN,
  VIDEO_FILE_NAME_MAX_LENGTH,
  VIDEO_MAX_FILE_SIZE_BYTES,
  VIDEO_TITLE_MAX_LENGTH,
} from '../videos.constants';

export class CreateVideoDto {
  /** Original file name, used as the default title and the download name. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(VIDEO_FILE_NAME_MAX_LENGTH)
  file_name: string;

  /** Size of the file in bytes (at most 10 GiB). */
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_FILE_SIZE_BYTES)
  file_size: number;

  /** Media type of the file; must be a `video/*` type. */
  @IsString()
  @Matches(VIDEO_CONTENT_TYPE_PATTERN)
  content_type: string;

  /** Optional title; defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(VIDEO_TITLE_MAX_LENGTH)
  title?: string;
}
