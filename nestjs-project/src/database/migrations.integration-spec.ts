import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1794920038153 } from './migrations/1794920038153-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

const MANAGED_ENUM_TYPES = [
  'verification_tokens_type_enum',
  'videos_status_enum',
];

async function existingTables(
  dataSource: DataSource,
  tables: string[],
): Promise<string[]> {
  const result = await dataSource.query<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [tables],
  );
  return result.map((r) => r.table_name);
}

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1794920038153,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential: a single DataSource connection cannot run concurrent queries.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    // DROP TABLE ... CASCADE does not remove enum types created by migrations;
    // leaving them makes the migration under test fail with "already exists".
    for (const enumType of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "${enumType}" CASCADE`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving the videos table missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    // `finally` guarantees the connection closes even if re-applying fails,
    // otherwise the open pool keeps Jest from exiting.
    try {
      await dataSource.runMigrations();
    } finally {
      await dataSource.destroy();
    }
  });

  it('should apply all migrations and create all managed tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);
    await expect(existingTables(dataSource, MANAGED_TABLES)).resolves.toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);

    const enumValues = await dataSource.query<{ value: string }[]>(
      `SELECT unnest(enum_range(NULL::videos_status_enum))::text AS value`,
    );
    expect(enumValues.map((r) => r.value)).toEqual([
      'draft',
      'processing',
      'ready',
      'failed',
    ]);
  });

  it('should revert the last migration, removing only videos and its enum', async () => {
    await dataSource.undoLastMigration();

    await expect(existingTables(dataSource, MANAGED_TABLES)).resolves.toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
    const enumType = await dataSource.query<unknown[]>(
      `SELECT 1 FROM pg_type WHERE typname = 'videos_status_enum'`,
    );
    expect(enumType).toHaveLength(0);
  });
});
