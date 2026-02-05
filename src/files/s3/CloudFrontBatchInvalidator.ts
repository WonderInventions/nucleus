import { randomUUID } from 'crypto';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import debug from 'debug';

import S3Store from './S3Store';
import * as config from '../../config';

const d = debug('nucleus:s3:cloudfront-invalidator');

const invalidators: {
  [id: string]: CloudFrontBatchInvalidator;
} = {};

const INVALIDATE_PER_ATTEMPT = 500;

export class CloudFrontBatchInvalidator {
  private lastAdd: number = 0;
  private queue: string[] = [];
  nextTimer: ReturnType<typeof setTimeout>;

  static noopInvalidator = new CloudFrontBatchInvalidator(null);

  static get(store: S3Store) {
    if (!store.s3Config.cloudfront) {
      return CloudFrontBatchInvalidator.noopInvalidator;
    }
    if (!invalidators[store.s3Config.cloudfront.distributionId]) {
      invalidators[store.s3Config.cloudfront.distributionId] = new CloudFrontBatchInvalidator(store.s3Config.cloudfront);
    }
    return invalidators[store.s3Config.cloudfront.distributionId];
  }

  private constructor(private cloudfrontConfig: S3Options['cloudfront']) {
    if (cloudfrontConfig) {
      this.queueUp();
    }
  }

  public addToBatch = (key: string) => {
    if (!this.cloudfrontConfig) return;
    const sanitizedKey = encodeURI(`/${key}`);
    if (this.queue.some(item => item === sanitizedKey)) return;
    this.queue.push(sanitizedKey);
    this.lastAdd = Date.now();
  }

  private queueUp() {
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => this.runJob(), 30000);
  }

  async runJob() {
    if (this.queue.length === 0 || Date.now() - this.lastAdd <= 20000) {
      return this.queueUp();
    }
    d('running cloudfront batch invalidator');
    const itemsToUse = this.queue.slice(0, INVALIDATE_PER_ATTEMPT);
    this.queue = this.queue.slice(INVALIDATE_PER_ATTEMPT);

    const cloudFront = this.getCloudFront();
    try {
      await cloudFront.send(new CreateInvalidationCommand({
        DistributionId: this.cloudfrontConfig!.distributionId,
        InvalidationBatch: {
          CallerReference: randomUUID(),
          Paths: {
            Quantity: itemsToUse.length,
            Items: itemsToUse,
          },
        },
      }));
      d('batch invalidation succeeded, moving along');
    } catch (err) {
      console.error(JSON.stringify({
        err,
        message: 'Failed to invalidate',
        keys: itemsToUse,
      }));
      this.queue.push(...itemsToUse);
    }
    this.queueUp();
  }

  private getCloudFront(): CloudFrontClient {
    const options: ConstructorParameters<typeof CloudFrontClient>[0] = {};
    if (config.s3.init && config.s3.init.endpoint) {
      options.endpoint = config.s3.init.endpoint;
    }
    return new CloudFrontClient(options);
  }
}
