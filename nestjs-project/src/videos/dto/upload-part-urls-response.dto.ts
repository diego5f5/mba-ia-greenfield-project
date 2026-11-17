import { ApiProperty } from '@nestjs/swagger';

export class UploadPartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description: 'Presigned URL; send the part bytes to it with HTTP PUT',
  })
  url: string;
}

export class UploadPartUrlsResponseDto {
  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];

  @ApiProperty({
    description: 'Lifetime of the URLs, in seconds',
    example: 3600,
  })
  expires_in: number;
}
