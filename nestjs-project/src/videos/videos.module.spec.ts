import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile, register the Video repository and the processing queue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (db: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres',
            host: db.host,
            port: db.port,
            username: db.username,
            password: db.password,
            database: db.name,
            entities: ALL_ENTITIES,
            synchronize: false,
          }),
        }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (queue: ConfigType<typeof queueConfig>) => ({
            connection: { host: queue.host, port: queue.port },
          }),
        }),
        VideosModule,
      ],
    }).compile();

    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    expect(module.get(VideosService)).toBeInstanceOf(VideosService);

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue.name).toBe('video-processing');
    expect(queue.defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    expect(queue.defaultJobOptions.removeOnComplete).toBeUndefined();
    expect(queue.defaultJobOptions.removeOnFail).toBeUndefined();

    await module.close();
  }, 15000);
});
