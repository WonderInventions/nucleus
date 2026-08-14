import {
  S3Client,
  HeadObjectCommand,
  CopyObjectCommand,
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
 * An inactivity timeout on the socket, which the handler destroys and rejects the moment it fires.
 * A multi-hundred megabyte installer keeps resetting it for as long as bytes are moving, so only a
 * connection that has gone completely silent is abandoned.
 *
 * Not `requestTimeout`, which is a deadline for the whole request and would cut off a large but
 * perfectly healthy transfer -- and which, absent `throwOnRequestTimeout`, only logs a warning and
 * leaves the socket open, so nothing fails and the retries below never engage.
 *
 * Without one, a stalled connection is bounded by nothing but the kernel's TCP retransmit budget,
 * which is around a quarter of an hour.  A release publishing every platform at once holds the
 * caller for the whole of that, and it has already timed out a release client that gave up long
 * before Nucleus did.
 */
export const S3_SOCKET_TIMEOUT_MS = 60_000;

// Aborting a stalled request only helps if the retry is what completes it, and a release is not
// re-runnable once its drafts are consumed, so this sits above the SDK's default of 3
export const S3_MAX_ATTEMPTS = 5;

/**
 * The SDK's retries cover fetching an object, not reading it: the body arrives afterwards, on a
 * stream it has already handed over, so a connection that dies part way through a large installer
 * comes back as a bare read error with nothing behind it.  Releasing consumes the drafts, so that
 * error costs a re-cut build -- worth a few more attempts of our own.
 */
export const S3_READ_ATTEMPTS = 3;

export const buildS3ClientOptions = (s3Config: S3Options): NonNullable<ConstructorParameters<typeof S3Client>[0]> => {
  // The timeouts are handed over as plain options rather than a constructed NodeHttpHandler so
  // the SDK keeps owning which handler it builds them into
  const options: NonNullable<ConstructorParameters<typeof S3Client>[0]> = {
    maxAttempts: S3_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      socketTimeout: S3_SOCKET_TIMEOUT_MS,
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

// CopySource is one string carrying both bucket and key, and the SDK sends it as given, so the
// key has to be escaped here.  Roam ships installers with a space in the name ("Roam Setup.exe")
// and every latest/ key is "<app name>.<ext>", so an unescaped source is not a corner case
const encodeCopySource = (bucket: string, key: string) =>
  `${bucket}/${key}`.split('/').map(encodeURIComponent).join('/');

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
      // putFile and copyFile skip the write when this reports the key is already there, so a check
      // that could not be answered must not answer yes: that is a file dropped from a release with
      // the write reported as a no-op it never was
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
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
      // Callers read a zero as "not in the store yet" and carry on without it, so only a missing
      // key may answer with one.  A throttled or failed HEAD answering the same way is how the
      // linux repos would come to publish metadata with a package silently left out
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return 0;
      }
      throw err;
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

  public async copyFile(fromKey: string, toKey: string, overwrite = false) {
    d(`Copying file: '${fromKey}' to '${toKey}', overwrite=${overwrite ? 'true' : 'false'}`);
    const s3 = this.getS3();
    let wrote = false;
    if (overwrite || !await this.hasFile(toKey)) {
      d(`Deciding to write file (either because overwrite is enabled or the key didn't exist)`);
      await s3.send(new CopyObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: toKey,
        CopySource: encodeCopySource(this.s3Config.bucketName, fromKey),
      }));
      wrote = true;
    }
    if (overwrite) {
      CloudFrontBatchInvalidator.get(this).addToBatch(toKey);
    }
    return wrote;
  }

  public async getFile(key: string) {
    d(`Fetching file: '${key}'`);
    const s3 = this.getS3();
    let lastError: any;
    for (let attempt = 1; attempt <= S3_READ_ATTEMPTS; attempt += 1) {
      try {
        const response = await s3.send(new GetObjectCommand({
          Bucket: this.s3Config.bucketName,
          Key: key,
        }));
        if (!response.Body) {
          return Buffer.from('');
        }
        const bytes = await response.Body.transformToByteArray();
        if (response.ContentLength !== undefined && bytes.length !== response.ContentLength) {
          throw new Error(`Read ${bytes.length} bytes of '${key}' from the store, which said it would send ${response.ContentLength}`);
        }
        return Buffer.from(bytes);
      } catch (err: any) {
        // An empty buffer is how every caller reads "not in the store", and the lock, the .ref
        // markers and versions.json are all read that way, so answering a failure with one is how
        // a blip comes to look like an unlocked channel or a version list with nothing in it
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          d('File not found, defaulting to empty buffer');
          return Buffer.from('');
        }
        d(`Failed to read '${key}' on attempt ${attempt} of ${S3_READ_ATTEMPTS}: ${err.message}`);
        lastError = err;
      }
    }
    throw lastError;
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
