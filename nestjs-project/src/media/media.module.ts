import { Module } from '@nestjs/common';
import { MediaProbeService } from './media-probe.service';

/** Wrapper of the system `ffprobe`/`ffmpeg` binaries (phase-03-videos/TD-08). */
@Module({
  providers: [MediaProbeService],
  exports: [MediaProbeService],
})
export class MediaModule {}
