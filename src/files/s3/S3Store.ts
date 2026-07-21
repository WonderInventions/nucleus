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

export default class S3Store implements IFileStore {
  private s3Client: S3Client | null = null;

  constructor(public s3Config = config.s3) {}

  private getS3(): S3Client {
    if (this.s3Client) {
      return this.s3Client;
    }

    const options: ConstructorParameters<typeof S3Client>[0] = {};

    if (this.s3Config.init) {
      if (this.s3Config.init.endpoint) {
        options.endpoint = this.s3Config.init.endpoint;
      }
      if (this.s3Config.init.s3ForcePathStyle) {
        options.forcePathStyle = this.s3Config.init.s3ForcePathStyle;
      }
      if (this.s3Config.init.credentials) {
        options.credentials = this.s3Config.init.credentials;
      }
      if (this.s3Config.init.region) {
        options.region = this.s3Config.init.region;
      }
      if (this.s3Config.init.requestChecksumCalculation) {
        options.requestChecksumCalculation = this.s3Config.init.requestChecksumCalculation;
      }
      if (this.s3Config.init.responseChecksumValidation) {
        options.responseChecksumValidation = this.s3Config.init.responseChecksumValidation;
      }
    }

    this.s3Client = new S3Client(options);
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
      await s3.send(new DeleteObjectsCommand({
        Bucket: this.s3Config.bucketName,
        Delete: {
          Objects: keys.slice(i, i + MAX_DELETE_BATCH).map(k => ({ Key: k })),
        },
      }));
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
