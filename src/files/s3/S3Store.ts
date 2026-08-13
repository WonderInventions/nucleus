import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  paginateListObjectsV2,
} from '@aws-sdk/client-s3';

import debug from 'debug';

import { CloudFrontBatchInvalidator } from './CloudFrontBatchInvalidator';
import * as config from '../../config';

const d = debug('nucleus:s3');

// S3 and R2 both reject DeleteObjects requests with more than 1000 keys
const MAX_DELETE_BATCH = 1000;

export const S3_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * An *inactivity* timeout on the socket, not a deadline for the whole request, so a multi-hundred
 * megabyte installer upload keeps resetting it for as long as bytes are moving and is never cut
 * off part way.  Only a connection that has gone completely silent is abandoned.
 *
 * Without one, a stalled connection is bounded by nothing but the kernel's TCP retransmit budget,
 * which is around a quarter of an hour.  A release publishing every platform at once holds the
 * caller for the whole of that, and it has already timed out a release client that gave up long
 * before Nucleus did.
 */
export const S3_REQUEST_TIMEOUT_MS = 60_000;

// Aborting a stalled request only helps if the retry is what completes it, and a release is not
// re-runnable once its drafts are consumed, so this sits above the SDK's default of 3
export const S3_MAX_ATTEMPTS = 5;

export const buildS3ClientOptions = (s3Config: S3Options): NonNullable<ConstructorParameters<typeof S3Client>[0]> => {
  // The timeouts are handed over as plain options rather than a constructed NodeHttpHandler so
  // the SDK keeps owning which handler it builds them into
  const options: NonNullable<ConstructorParameters<typeof S3Client>[0]> = {
    maxAttempts: S3_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
    },
  };

  if (s3Config.init) {
    if (s3Config.init.endpoint) {
      options.endpoint = s3Config.init.endpoint;
    }
    if (s3Config.init.s3ForcePathStyle) {
      options.forcePathStyle = s3Config.init.s3ForcePathStyle;
    }
    if (s3Config.init.credentials) {
      options.credentials = s3Config.init.credentials;
    }
    if (s3Config.init.region) {
      options.region = s3Config.init.region;
    }
    if (s3Config.init.requestChecksumCalculation) {
      options.requestChecksumCalculation = s3Config.init.requestChecksumCalculation;
    }
    if (s3Config.init.responseChecksumValidation) {
      options.responseChecksumValidation = s3Config.init.responseChecksumValidation;
    }
  }

  return options;
};

export default class S3Store implements IFileStore {
  private s3Client: S3Client | null = null;

  constructor(public s3Config = config.s3) {}

  private getS3(): S3Client {
    if (this.s3Client) {
      return this.s3Client;
    }

    this.s3Client = new S3Client(buildS3ClientOptions(this.s3Config));
    return this.s3Client;
  }

  public async hasFile(key: string) {
    const s3 = this.getS3();
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: key,
      }));
      return true;
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      return true;
    }
  }

  public async getFileSize(key: string) {
    const s3 = this.getS3();
    try {
      const response = await s3.send(new HeadObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: key,
      }));
      return response.ContentLength || 0;
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return 0;
      }
      return 0;
    }
  }

  public async putFile(key: string, data: Buffer, overwrite = false) {
    d(`Putting file: '${key}', overwrite=${overwrite ? 'true' : 'false'}`);
    const s3 = this.getS3();
    let wrote = false;
    if (overwrite || !await this.hasFile(key)) {
      d(`Deciding to write file (either because overwrite is enabled or the key didn't exist)`);
      await s3.send(new PutObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: key,
        Body: data,
      }));
      wrote = true;
    }
    if (overwrite) {
      CloudFrontBatchInvalidator.get(this).addToBatch(key);
    }
    return wrote;
  }

  public async getFile(key: string) {
    d(`Fetching file: '${key}'`);
    const s3 = this.getS3();
    try {
      const response = await s3.send(new GetObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: key,
      }));
      if (response.Body) {
        const bytes = await response.Body.transformToByteArray();
        return Buffer.from(bytes);
      }
      return Buffer.from('');
    } catch (err) {
      d('File not found, defaulting to empty buffer');
      return Buffer.from('');
    }
  }

  public async deletePath(key: string) {
    d(`Deleting files under path: '${key}'`);
    const s3 = this.getS3();
    const keys = await this.listFiles(key);
    d(`Found objects to delete: [${keys.join(', ')}]`);
    for (let i = 0; i < keys.length; i += MAX_DELETE_BATCH) {
      const response = await s3.send(new DeleteObjectsCommand({
        Bucket: this.s3Config.bucketName,
        Delete: {
          Objects: keys.slice(i, i + MAX_DELETE_BATCH).map(k => ({ Key: k })),
        },
      }));
      // DeleteObjects reports per-key failures in a 200 response; treat them
      // as errors so callers never mistake a partial delete for success
      if (response.Errors && response.Errors.length > 0) {
        console.error(JSON.stringify({
          message: 'Some objects failed to delete',
          bucket: this.s3Config.bucketName,
          path: key,
          errors: response.Errors.map(e => ({ key: e.Key, code: e.Code, error: e.Message })),
        }));
        throw new Error(`Failed to delete ${response.Errors.length} object(s) under '${key}' in bucket '${this.s3Config.bucketName}'`);
      }
    }
  }

  public async getPublicBaseUrl() {
    const { publicBaseUrl, cloudfront, init } = this.s3Config;

    if (publicBaseUrl) {
      return publicBaseUrl;
    }

    if (cloudfront) {
      return cloudfront.publicUrl;
    }

    if (init && init.endpoint) {
      return init.endpoint;
    }

    return `https://${this.s3Config.bucketName}.s3.amazonaws.com`;
  }

  public async listFiles(prefix: string) {
    d(`Listing files under path: '${prefix}'`);
    const s3 = this.getS3();
    const keys: string[] = [];
    const paginator = paginateListObjectsV2({ client: s3 }, {
      Bucket: this.s3Config.bucketName,
      Prefix: prefix,
    });
    for await (const page of paginator) {
      for (const object of page.Contents || []) {
        if (object.Key) {
          keys.push(object.Key);
        }
      }
    }
    return keys;
  }
}
