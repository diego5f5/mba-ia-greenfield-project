import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { VIDEO_MAX_PARTS_PER_UPLOAD } from '../videos.constants';

export class CompletedPartDto {
  /** Part number the bytes were uploaded as (starting at 1). */
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_PARTS_PER_UPLOAD)
  part_number: number;

  /** `ETag` header returned by the storage when the part was uploaded. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every uploaded part, with the ETag the storage returned for it. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_MAX_PARTS_PER_UPLOAD)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
