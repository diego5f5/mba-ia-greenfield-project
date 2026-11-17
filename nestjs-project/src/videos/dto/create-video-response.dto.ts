import { ApiProperty } from '@nestjs/swagger';
import { VideoResponseDto } from './video-response.dto';

export class UploadPlanDto {
  @ApiProperty({
    description: 'Size in bytes of every part except the last',
    example: 67108864,
  })
  part_size: number;

  @ApiProperty({
    description: 'Number of parts the client must upload',
    example: 160,
  })
  part_count: number;
}

export class CreateVideoResponseDto extends VideoResponseDto {
  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;
}
