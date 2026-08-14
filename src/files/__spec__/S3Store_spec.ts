import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { stub } from 'sinon';
import {
  S3Client,
  HeadObjectCommand,
  CopyObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'stream';

import { CloudFrontBatchInvalidator } from '../s3/CloudFrontBatchInvalidator';
import S3Store, {
  buildS3ClientOptions,
  S3_CONNECTION_TIMEOUT_MS,
  S3_MAX_ATTEMPTS,
  S3_READ_ATTEMPTS,
  S3_SOCKET_TIMEOUT_MS,
} from '../s3/S3Store';

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

    it('should return false for a 404 that does not name itself NotFound', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'SomethingElse', $metadata: { httpStatusCode: 404 } });
      assert.strictEqual(await store.hasFile('myKey'), false);
    });

    // A yes is what makes putFile skip the write, so a failed check answering with one drops a
    // file from the release and reports nothing
    it('should throw when the check cannot be answered', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'InternalError', $metadata: { httpStatusCode: 500 } });

      await assert.rejects(store.hasFile('myKey'), { name: 'InternalError' });
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

    it('should return 0 for a 404 that does not name itself NotFound', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'SomethingElse', $metadata: { httpStatusCode: 404 } });
      assert.strictEqual(await store.getFileSize('myKey'), 0);
    });

    // Callers read a zero as "not there yet" and carry on without the file, so a failed check must
    // not answer with one
    it('should throw when the size cannot be read', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'InternalError', $metadata: { httpStatusCode: 500 } });
      await assert.rejects(store.getFileSize('myKey'), { name: 'InternalError' });
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

  describe('copyFile', () => {
    it('should copy inside the store rather than moving the bytes', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound' });
      s3Mock.on(CopyObjectCommand).resolves({});

      assert.strictEqual(await store.copyFile('from/key', 'to/key'), true);

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].args[0].input.Bucket, 'myBucket');
      assert.strictEqual(calls[0].args[0].input.Key, 'to/key');
      assert.strictEqual(calls[0].args[0].input.CopySource, 'myBucket/from/key');
      assert.strictEqual(s3Mock.commandCalls(GetObjectCommand).length, 0);
      assert.strictEqual(s3Mock.commandCalls(PutObjectCommand).length, 0);
    });

    // Every latest/ key is "<app name>.<ext>", and Roam's own installer is "Roam Setup.exe"
    it('should escape a source key the way CopySource needs, without escaping the separators', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound' });
      s3Mock.on(CopyObjectCommand).resolves({});

      await store.copyFile('app/chan/_index/1.0.0/win32/x64/Roam Setup.exe', 'to/key');

      assert.strictEqual(
        s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input.CopySource,
        'myBucket/app/chan/_index/1.0.0/win32/x64/Roam%20Setup.exe',
      );
    });

    it('should not overwrite files by default', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      s3Mock.on(CopyObjectCommand).resolves({});

      assert.strictEqual(await store.copyFile('from/key', 'to/key'), false);

      assert.strictEqual(s3Mock.commandCalls(CopyObjectCommand).length, 0);
    });

    it('should overwrite files when overwrite = true', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      s3Mock.on(CopyObjectCommand).resolves({});

      assert.strictEqual(await store.copyFile('from/key', 'to/key', true), true);

      assert.strictEqual(s3Mock.commandCalls(CopyObjectCommand).length, 1);
    });

    // A copy replaces whatever the CDN is already serving at that key, exactly as a put does.
    // The invalidator is stubbed rather than built: constructing a real one starts a repeating
    // timer that outlives the test run
    it('should invalidate the destination when it overwrites', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      s3Mock.on(CopyObjectCommand).resolves({});
      const addToBatch = stub();
      const get = stub(CloudFrontBatchInvalidator, 'get').returns({ addToBatch } as any);

      try {
        await store.copyFile('from/key', 'to/key', true);
        assert.deepStrictEqual(addToBatch.getCalls().map(c => c.args[0]), ['to/key']);
      } finally {
        get.restore();
      }
    });

    it('should not invalidate anything when it leaves an existing key alone', async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      const addToBatch = stub();
      const get = stub(CloudFrontBatchInvalidator, 'get').returns({ addToBatch } as any);

      try {
        assert.strictEqual(await store.copyFile('from/key', 'to/key'), false);
        assert.strictEqual(addToBatch.callCount, 0);
      } finally {
        get.restore();
      }
    });

    it('should propagate a failed copy rather than reporting success', async () => {
      s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound' });
      s3Mock.on(CopyObjectCommand).rejects(new Error('copy exploded'));

      await assert.rejects(store.copyFile('from/key', 'to/key'), /copy exploded/);
    });
  });

  describe('getFile', () => {
    const bodyOf = (value: string) => {
      const stream = new Readable();
      stream.push(Buffer.from(value));
      stream.push(null);
      return sdkStreamMixin(stream);
    };

    it('should default to empty buffer when file not found', async () => {
      s3Mock.on(GetObjectCommand).rejects({ name: 'NoSuchKey' });
      const result = await store.getFile('key');
      assert.strictEqual(result.toString(), '');
    });

    it('should default to empty buffer for a 404 that does not name itself', async () => {
      s3Mock.on(GetObjectCommand).rejects({ name: 'SomethingElse', $metadata: { httpStatusCode: 404 } });
      assert.strictEqual((await store.getFile('key')).toString(), '');
    });

    it('should load the file contents if it exists', async () => {
      s3Mock.on(GetObjectCommand).resolves({ Body: bodyOf('thisIsValue') });
      const result = await store.getFile('key');
      assert.strictEqual(result.toString(), 'thisIsValue');
    });

    // The lock, the .ref markers and versions.json are all read as "empty means not there", so a
    // failed read answering with an empty buffer reads as an unlocked channel or no versions at all
    it('should throw when the read fails rather than answer with an empty buffer', async () => {
      s3Mock.on(GetObjectCommand).rejects({ name: 'TimeoutError', message: 'socket timed out' });

      await assert.rejects(store.getFile('key'), { name: 'TimeoutError' });
    });

    it('should retry a failed read before giving up on it', async () => {
      s3Mock.on(GetObjectCommand)
        .rejectsOnce({ name: 'TimeoutError' })
        .rejectsOnce({ name: 'TimeoutError' })
        .resolves({ Body: bodyOf('thisIsValue') });

      assert.strictEqual((await store.getFile('key')).toString(), 'thisIsValue');
      assert.strictEqual(s3Mock.commandCalls(GetObjectCommand).length, S3_READ_ATTEMPTS);
    });

    it('should give up after a bounded number of attempts', async () => {
      s3Mock.on(GetObjectCommand).rejects({ name: 'TimeoutError' });

      await assert.rejects(store.getFile('key'), { name: 'TimeoutError' });
      assert.strictEqual(s3Mock.commandCalls(GetObjectCommand).length, S3_READ_ATTEMPTS);
    });

    // A body that stops early is the shape a dropped connection takes, and a half-read installer
    // published as a whole one is worse than a release that fails
    it('should throw when fewer bytes arrive than the store said it would send', async () => {
      // A fresh body per call, since a retry gets a new response rather than re-reading the stream
      s3Mock.on(GetObjectCommand).callsFake(() => ({ Body: bodyOf('short'), ContentLength: 11 }));

      await assert.rejects(store.getFile('key'), /Read 5 bytes of 'key'.*would send 11/);
      assert.strictEqual(s3Mock.commandCalls(GetObjectCommand).length, S3_READ_ATTEMPTS);
    });

    it('should accept a body that matches the length the store reported', async () => {
      s3Mock.on(GetObjectCommand).resolves({ Body: bodyOf('thisIsValue'), ContentLength: 11 });

      assert.strictEqual((await store.getFile('key')).toString(), 'thisIsValue');
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

  describe('buildS3ClientOptions', () => {
    it('should bound how long a silent connection can hang', () => {
      const options = buildS3ClientOptions(s3Config);

      assert.deepStrictEqual(options.requestHandler, {
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        socketTimeout: S3_SOCKET_TIMEOUT_MS,
      });
      assert.strictEqual(S3_CONNECTION_TIMEOUT_MS, 10_000);
      assert.strictEqual(S3_SOCKET_TIMEOUT_MS, 20_000);
    });

    // A copy is silent for as long as the store takes to duplicate the object, measured at up to
    // 7.6s for the installers, and it is the only thing here that has no bytes to keep it alive
    it('should leave room for a server side copy to finish', () => {
      assert.ok(S3_SOCKET_TIMEOUT_MS >= 15_000, 'a copy of a ~200MB installer needs the headroom');
    });

    // requestTimeout looks like the same setting and is not: it bounds the whole request rather
    // than a silence, and on its own it only logs a warning, so a stalled release keeps stalling
    it('should not bound the whole request, only a silent one', () => {
      const handler = buildS3ClientOptions(s3Config).requestHandler as Record<string, unknown>;

      assert.ok(!('requestTimeout' in handler), 'requestTimeout would cut off a large healthy transfer');
    });

    it('should retry more than the SDK default, since aborting alone does not finish the request', () => {
      assert.strictEqual(buildS3ClientOptions(s3Config).maxAttempts, S3_MAX_ATTEMPTS);
      assert.strictEqual(S3_MAX_ATTEMPTS, 5);
    });

    it('should still pass every init option through to the client', () => {
      s3Config.init = {
        endpoint: 'https://example.r2.cloudflarestorage.com',
        s3ForcePathStyle: true,
        credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
        region: 'auto',
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      } as S3Options['init'];

      const options = buildS3ClientOptions(s3Config);

      assert.strictEqual(options.endpoint, 'https://example.r2.cloudflarestorage.com');
      assert.strictEqual(options.forcePathStyle, true);
      assert.deepStrictEqual(options.credentials, { accessKeyId: 'id', secretAccessKey: 'secret' });
      assert.strictEqual(options.region, 'auto');
      assert.strictEqual(options.requestChecksumCalculation, 'WHEN_REQUIRED');
      assert.strictEqual(options.responseChecksumValidation, 'WHEN_REQUIRED');
    });

    // Handing the SDK plain options instead of a NodeHttpHandler leaves it free to ignore them
    // without erroring, and it resolves both the handler config and maxAttempts lazily, so this
    // reaches through a real client rather than trusting the object we handed it
    it('should reach a constructed client', async () => {
      const client = new S3Client(buildS3ClientOptions(s3Config));

      assert.strictEqual(await client.config.maxAttempts(), S3_MAX_ATTEMPTS);

      const handler = client.config.requestHandler as { configProvider?: Promise<Record<string, unknown>> };
      assert.ok(handler.configProvider, 'expected the request handler to expose its pending config');
      const handlerConfig = await handler.configProvider;
      assert.strictEqual(handlerConfig.connectionTimeout, S3_CONNECTION_TIMEOUT_MS);
      assert.strictEqual(handlerConfig.socketTimeout, S3_SOCKET_TIMEOUT_MS);
    });
  });
});
