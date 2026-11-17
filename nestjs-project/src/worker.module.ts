import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from './auth/entities/refresh-token.entity';
import { VerificationToken } from './auth/entities/verification-token.entity';
import { Channel } from './channels/entities/channel.entity';
import appConfig from './config/app.config';
import authConfig from './config/auth.config';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import mailConfig from './config/mail.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import swaggerConfig from './config/swagger.config';
import { MediaModule } from './media/media.module';
import { StorageModule } from './storage/storage.module';
import { User } from './users/entities/user.entity';
import { Video } from './videos/entities/video.entity';
import { VideoProcessingProcessor } from './videos/video-processing.processor';
import { VIDEO_PROCESSING_QUEUE } from './videos/videos.constants';

/**
 * Root of the video worker: same codebase as the API, but a Nest context
 * without HTTP. The `VideoProcessingProcessor` lives only here, so the API
 * never consumes jobs (phase-03-videos/TD-07).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        swaggerConfig,
        storageConfig,
        queueConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // `Video` relates to `Channel` → `User`; without the API's modules
        // `autoLoadEntities` would not register the whole relation graph.
        entities: [User, Channel, RefreshToken, VerificationToken, Video],
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        connection: { host: queue.host, port: queue.port },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    MediaModule,
  ],
  providers: [VideoProcessingProcessor],
})
export class WorkerModule {}
