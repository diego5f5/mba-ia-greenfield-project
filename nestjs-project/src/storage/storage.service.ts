import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  MULTIPART_REJECTION_ERROR_NAMES,
  MultipartUploadRejectedError,
} from './storage.errors';

export interface CompletedUploadPart {
  partNumber: number;
  etag: string;
}

export interface StoredObjectInfo {
  contentLength: number;
  contentType: string;
}

export type SigningEndpoint = 'public' | 'internal';

export interface PresignGetObjectOptions {
  expiresIn: number;
  endpoint: SigningEndpoint;
  responseContentType?: string;
  responseContentDisposition?: string;
}

/**
 * Single gateway to the S3-compatible object storage (phase-03-videos/TD-01).
 *
 * Two clients (phase-03-videos/TD-02): `internalClient` performs every network
 * call through the Compose service name; `publicClient` only signs URLs handed
 * to clients outside the Compose network (signing is local, no network call).
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.internalClient = StorageService.createClient(config, config.endpoint);
    this.publicClient = StorageService.createClient(
      config,
      config.publicEndpoint,
    );
  }

  private static createClient(
    config: ConfigType<typeof storageConfig>,
    endpoint: string,
  ): S3Client {
    return new S3Client({
      endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      // Presigned part URLs must not embed checksum headers a plain PUT
      // cannot reproduce (phase-03-videos/TD-01).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for key ${key}`);
    }
    return UploadId;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(({ partNumber, etag }) => ({
              PartNumber: partNumber,
              ETag: etag,
            })),
          },
        }),
      );
    } catch (error) {
      if (isMultipartRejection(error)) {
        throw new MultipartUploadRejectedError(error.name, { cause: error });
      }
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Returns `null` when the object does not exist. */
  async headObject(key: string): Promise<StoredObjectInfo | null> {
    try {
      const result = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentLength: result.ContentLength ?? 0,
        contentType: result.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFound') {
        return null;
      }
      throw error;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /** Presigned `PUT` for one part, always signed for external clients. */
  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async presignGetObject(
    key: string,
    options: PresignGetObjectOptions,
  ): Promise<string> {
    const client =
      options.endpoint === 'public' ? this.publicClient : this.internalClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: options.responseContentType,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }
}

function isMultipartRejection(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (MULTIPART_REJECTION_ERROR_NAMES as readonly string[]).includes(error.name)
  );
}
