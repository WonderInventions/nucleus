import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'stream';

import S3Store from '../s3/S3Store';

describe('S3Store', () => {
  let store: S3Store;
  let s3Config: S3Options;
  const s3Mock = mockClient(S3Client);
  const cfMock = mockClient(CloudFrontClient);

  beforeEach(() => {
    s3Config = {
      bucketName: 'myBucket',
      cloudfront: null,
    };
    store = new S3Store(s3Config);
    s3Mock.reset();
    cfMock.reset();
  });

  afterEach(() => {
    s3Mock.reset();
    cfMock.reset();
  });

  describe('getPublicBaseUrl', () => {
    it('should return the calculated S3 URL', async () => {
      assert.strictEqual(await store.getPublicBaseUrl(), 'https://myBucket.s3.amazonaws.com');
    });

    it('should return the cloudfront static URL if provided', async () => {
      s3Config.cloudfront = {
        distributionId: '0',
        publicUrl: 'https://this.is.custom/lel',
      };
      const storeWithCf = new S3Store(s3Config);
      assert.strictEqual(await storeWithCf.getPublicBaseUrl(), 'https://this.is.custom/lel');
    });

    it('should return the custom endpoint if provided', async () => {
      s3Config.init = {
        endpoint: 'https://custom-s3-endpoint.example.com',
      };
      const storeWithEndpoint = new S3Store(s3Config);
      assert.strictEqual(await storeWithEndpoint.getPublicBaseUrl(), 'https://custom-s3-endpoint.example.com');
    });

    it('should prefer publicBaseUrl over the cloudfront static URL', async () => {
      s3Config.publicBaseUrl = 'https://download.example.com';
      s3Config.cloudfront = {
        distributionId: '0',
        publicUrl: 'https://this.is.custom/lel',
      };
      const storeWithPublicBaseUrl = new S3Store(s3Config);
      assert.strictEqual(await storeWithPublicBaseUrl.getPublicBaseUrl(), 'https://download.example.com');
    });

    it('should prefer publicBaseUrl over the custom endpoint when cloudfront is null', async () => {
      s3Config.publicBaseUrl = 'https://download.example.com';
      s3Config.init = {
        endpoint: 'https://account-id.r2.cloudflarestorage.com',
      };
      const storeWithPublicBaseUrl = new S3Store(s3Config);
      assert.strictEqual(await storeWithPublicBaseUrl.getPublicBaseUrl(), 'https://download.example.com');
    });
  });

  describe('hasFile', () => {
    it('should return true when headObject succeeds', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      assert.strictEqual(await store.hasFile('myKey'), true);
    });

    it('should return false when headObject returns NotFound', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound' });
      assert.strictEqual(await store.hasFile('myKey'), false);
    });
  });

  describe('getFileSize', () => {
    it('should return the content length', async () => {
      s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1234 });
      assert.strictEqual(await store.getFileSize('myKey'), 1234);
    });

    it('should return 0 when file not found', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound' });
      assert.strictEqual(await store.getFileSize('myKey'), 0);
    });
  });

  describe('putFile', () => {
    it('should write files to the correct key', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound' });
      s3Mock.on(PutObjectCommand).resolves({});

      assert.strictEqual(await store.putFile('myKey', Buffer.from('value')), true);

      const calls = s3Mock.commandCalls(PutObjectCommand);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].args[0].input.Key, 'myKey');
      assert.strictEqual(calls[0].args[0].input.Bucket, 'myBucket');
    });

    it('should not overwrite files by default', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      s3Mock.on(PutObjectCommand).resolves({});

      assert.strictEqual(await store.putFile('myKey', Buffer.from('value')), false);

      const calls = s3Mock.commandCalls(PutObjectCommand);
      assert.strictEqual(calls.length, 0);
    });

    it('should overwrite files when overwrite = true', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      s3Mock.on(PutObjectCommand).resolves({});

      assert.strictEqual(await store.putFile('myKey', Buffer.from('value'), true), true);

      const calls = s3Mock.commandCalls(PutObjectCommand);
      assert.strictEqual(calls.length, 1);
    });

    it('should not send any cloudfront invalidation when cloudfront is null', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      s3Mock.on(PutObjectCommand).resolves({});

      assert.strictEqual(await store.putFile('myKey', Buffer.from('value'), true), true);

      assert.strictEqual(cfMock.calls().length, 0);
    });
  });

  describe('getFile', () => {
    it('should default to empty buffer when file not found', async () => {
      s3Mock.on(GetObjectCommand).rejects(new Error('Not found'));
      const result = await store.getFile('key');
      assert.strictEqual(result.toString(), '');
    });

    it('should load the file contents if it exists', async () => {
      const stream = new Readable();
      stream.push(Buffer.from('thisIsValue'));
      stream.push(null);
      const sdkStream = sdkStreamMixin(stream);

      s3Mock.on(GetObjectCommand).resolves({ Body: sdkStream });
      const result = await store.getFile('key');
      assert.strictEqual(result.toString(), 'thisIsValue');
    });
  });

  describe('listFiles', () => {
    it('should return keys from the bucket', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          { Key: 'file1.txt' },
          { Key: 'file2.txt' },
          { Key: 'subdir/file3.txt' },
        ],
      });

      const files = await store.listFiles('prefix');
      assert.deepStrictEqual(files, ['file1.txt', 'file2.txt', 'subdir/file3.txt']);
    });

    it('should return empty array when no files', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      const files = await store.listFiles('prefix');
      assert.deepStrictEqual(files, []);
    });

    it('should paginate across multiple pages of results', async () => {
      s3Mock.on(ListObjectsV2Command)
        .resolvesOnce({
          Contents: [{ Key: 'file1.txt' }, { Key: 'file2.txt' }],
          IsTruncated: true,
          NextContinuationToken: 'next-token',
        })
        .resolvesOnce({
          Contents: [{ Key: 'file3.txt' }],
        });

      const files = await store.listFiles('prefix');
      assert.deepStrictEqual(files, ['file1.txt', 'file2.txt', 'file3.txt']);

      const calls = s3Mock.commandCalls(ListObjectsV2Command);
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[1].args[0].input.ContinuationToken, 'next-token');
    });
  });

  describe('deletePath', () => {
    it('should delete all files under the path', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          { Key: 'prefix/file1.txt' },
          { Key: 'prefix/file2.txt' },
        ],
      });
      s3Mock.on(DeleteObjectsCommand).resolves({});

      await store.deletePath('prefix');

      const calls = s3Mock.commandCalls(DeleteObjectsCommand);
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].args[0].input.Delete?.Objects, [
        { Key: 'prefix/file1.txt' },
        { Key: 'prefix/file2.txt' },
      ]);
    });

    it('should not call deleteObjects when no files to delete', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });

      await store.deletePath('prefix');

      const calls = s3Mock.commandCalls(DeleteObjectsCommand);
      assert.strictEqual(calls.length, 0);
    });

    it('should throw when the delete response contains per-key errors', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: 'prefix/file1.txt' }],
      });
      s3Mock.on(DeleteObjectsCommand).resolves({
        Errors: [{ Key: 'prefix/file1.txt', Code: 'InternalError', Message: 'We encountered an internal error.' }],
      });

      await assert.rejects(store.deletePath('prefix'), /Failed to delete 1 object\(s\) under 'prefix'/);
    });

    it('should chunk deletes into batches of at most 1000 keys', async () => {
      const keys = Array.from({ length: 1500 }, (_, i) => ({ Key: `prefix/file${i}.txt` }));
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: keys });
      s3Mock.on(DeleteObjectsCommand).resolves({});

      await store.deletePath('prefix');

      const calls = s3Mock.commandCalls(DeleteObjectsCommand);
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[0].args[0].input.Delete?.Objects?.length, 1000);
      assert.strictEqual(calls[1].args[0].input.Delete?.Objects?.length, 500);
      const deletedKeys = calls.flatMap(call => (call.args[0].input.Delete?.Objects || []).map(o => o.Key));
      assert.deepStrictEqual(deletedKeys, keys.map(k => k.Key));
    });
  });
});
