import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { fromInstanceMetadata } from '@aws-sdk/credential-providers';
import debug from 'debug';

import { CloudFrontBatchInvalidator } from './CloudFrontBatchInvalidator';
import * as config from '../../config';

const d = debug('nucleus:s3');

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
    }

    // Use EC2 metadata credentials in non-test environments
    if (process.env.NODE_ENV !== 'test') {
      options.credentials = fromInstanceMetadata({
        timeout: 5000,
        maxRetries: 10,
      });
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
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: this.s3Config.bucketName,
        Delete: {
          Objects: keys.map(k => ({ Key: k })),
        },
      }));
    }
  }

  public async getPublicBaseUrl() {
    const { cloudfront, init } = this.s3Config;

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
    const response = await s3.send(new ListObjectsCommand({
      Bucket: this.s3Config.bucketName,
      Prefix: prefix,
    }));
    const objects = response.Contents || [];
    return objects.map(object => object.Key).filter((key): key is string => !!key);
  }
}
