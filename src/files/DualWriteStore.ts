import debug from 'debug';

const d = debug('nucleus:dual-write');

interface DualWriteOptions {
  mirrorWriteAttempts?: number;
  mirrorRetryDelayMs?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Mirrors every write to a secondary file store while serving all reads from
 * the primary.  Used during the S3 -> R2 transition so both backends stay
 * current and either can be served (or rolled back to) at any time.
 *
 * A write is only mirrored when the primary actually wrote, and always with
 * overwrite enabled, so the secondary converges to whatever the primary
 * accepted.  Mirror writes are best-effort: they are retried a few times and
 * on ultimate failure the drift is logged loudly but the write succeeds,
 * because the release flow cannot be retried once the primary has accepted
 * files -- a failing mirror must never wedge a release.  Drift is reconciled
 * by healing (a later put of a key the secondary is missing copies the
 * primary's bytes across) and by bulk re-syncs during the migration.
 *
 * Deletes remain strict: the flows that delete are retryable, so a failed
 * secondary delete propagates rather than leaving the mirror holding
 * objects the primary no longer has.
 */
export default class DualWriteStore implements IFileStore {
  private mirrorWriteAttempts: number;
  private mirrorRetryDelayMs: number;

  constructor(public primary: IFileStore, public secondary: IFileStore, options: DualWriteOptions = {}) {
    this.mirrorWriteAttempts = options.mirrorWriteAttempts ?? 3;
    this.mirrorRetryDelayMs = options.mirrorRetryDelayMs ?? 1000;
  }

  public async putFile(key: string, data: Buffer, overwriteExisting = false) {
    const wrote = await this.primary.putFile(key, data, overwriteExisting);
    if (wrote) {
      d(`Mirroring write of '${key}' to the secondary store`);
      await this.mirrorWrite(key, data);
    } else if (!await this.secondary.hasFile(key)) {
      // The primary already had this key but the secondary does not, e.g.
      // because an earlier mirror write failed.  Heal with the primary's
      // bytes, which are authoritative and may differ from this upload
      const primaryData = await this.primary.getFile(key);
      if (primaryData.length > 0) {
        console.log(JSON.stringify({
          message: 'Healing object missing from the secondary store',
          key,
        }));
        await this.mirrorWrite(key, primaryData);
      }
    }
    return wrote;
  }

  private async mirrorWrite(key: string, data: Buffer) {
    for (let attempt = 1; attempt <= this.mirrorWriteAttempts; attempt += 1) {
      try {
        await this.secondary.putFile(key, data, true);
        return;
      } catch (err) {
        if (attempt < this.mirrorWriteAttempts) {
          await sleep(this.mirrorRetryDelayMs * attempt);
          continue;
        }
        console.error(JSON.stringify({
          message: 'Failed to mirror a write to the secondary store, the stores have drifted',
          key,
          attempts: this.mirrorWriteAttempts,
          err: `${err}`,
        }));
      }
    }
  }

  public async deletePath(key: string) {
    await this.primary.deletePath(key);
    await this.secondary.deletePath(key);
  }

  public async hasFile(key: string) {
    return this.primary.hasFile(key);
  }

  public async getFile(key: string) {
    return this.primary.getFile(key);
  }

  public async getFileSize(key: string) {
    return this.primary.getFileSize(key);
  }

  public async getPublicBaseUrl() {
    return this.primary.getPublicBaseUrl();
  }

  public async listFiles(prefix: string) {
    return this.primary.listFiles(prefix);
  }
}
