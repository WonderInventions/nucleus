import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import S3Store from '../s3/S3Store';
import { CloudFrontBatchInvalidator } from '../s3/CloudFrontBatchInvalidator';

// Only the cloudfront: null path is tested here; constructing a real
// invalidator starts a self-rescheduling timer that keeps the test
// process alive
describe('CloudFrontBatchInvalidator', () => {
  describe('with cloudfront: null', () => {
    const store = new S3Store({
      bucketName: 'myBucket',
      cloudfront: null,
    });

    it('should return the noop invalidator', () => {
      assert.strictEqual(CloudFrontBatchInvalidator.get(store), CloudFrontBatchInvalidator.noopInvalidator);
    });

    it('should not schedule an invalidation timer', () => {
      assert.strictEqual(CloudFrontBatchInvalidator.noopInvalidator.nextTimer, undefined);
    });

    it('should ignore keys added to the batch', () => {
      const invalidator = CloudFrontBatchInvalidator.get(store);
      invalidator.addToBatch('some/key');
      assert.deepStrictEqual(invalidator['queue'], []);
    });
  });
});
