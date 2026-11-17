import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Infrastructure module: the only place that talks to the object storage.
 * Requires a global ConfigModule that loads `storageConfig`.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
