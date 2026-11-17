import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
};

const validate = (env: Record<string, string | undefined>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — storage and queue', () => {
  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const { error } = validate({ [key]: undefined });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply Compose-service defaults for endpoints, bucket and Redis', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    // Joi types `value` as `any`; narrow to the fields under test.
    const value = result.value as Record<string, string | number>;
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube-videos',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
    });
  });

  it('should reject a non-URI S3_ENDPOINT', () => {
    const { error } = validate({ S3_ENDPOINT: 'not a uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });
});

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    // Joi types `value` as `any`; narrow to the field under test.
    const value = result.value as { SWAGGER_ENABLED: string };
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});
