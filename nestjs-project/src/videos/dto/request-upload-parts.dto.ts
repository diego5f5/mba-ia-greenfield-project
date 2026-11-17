import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { VIDEO_MAX_PARTS_PER_REQUEST } from '../videos.constants';

export class RequestUploadPartsDto {
  /** Part numbers (starting at 1) to receive presigned upload URLs for. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_MAX_PARTS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
