import { registerAs } from '@nestjs/config';

/**
 * S3-compatible object storage (MinIO locally, S3 in production).
 *
 * `endpoint` is used for every network call made by the API and the worker
 * (Compose service name). `publicEndpoint` is used only to sign URLs handed to
 * clients outside the Compose network (phase-03-videos/TD-02).
 */
export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY ?? '',
  secretKey: process.env.S3_SECRET_KEY ?? '',
  bucket: process.env.S3_BUCKET || 'streamtube-videos',
}));
