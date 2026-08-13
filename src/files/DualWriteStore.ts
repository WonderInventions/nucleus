import debug from 'debug';

import { isUrlEmbeddingManifestKey, rewriteManifestBaseUrl } from './utils/manifestUrls';

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
 * Manifests that embed absolute download URLs (win32 RELEASES, darwin
 * RELEASES.json, yum .repo) are rendered from the primary's public base URL,
 * so when the secondary is served from a different domain their URLs are
 * rewritten to the secondary's base URL on the way through -- otherwise
 * clients hitting the secondary's domain would bounce back to the primary's.
 * This means bulk re-syncs between the backends must exclude those manifest
 * keys or they will clobber the rewritten copies.
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

  // Kept inside mirrorWrite's try/retry loop so a throwing getPublicBaseUrl
  // is treated like any failed mirror write instead of wedging the release
  private async dataForSecondary(key: string, data: Buffer) {
    if (!isUrlEmbeddingManifestKey(key)) return data;
    const [primaryBaseUrl, secondaryBaseUrl] = await Promise.all([
      this.primary.getPublicBaseUrl(),
      this.secondary.getPublicBaseUrl(),
    ]);
    return rewriteManifestBaseUrl(data, primaryBaseUrl, secondaryBaseUrl);
  }

  public async copyFile(fromKey: string, toKey: string, overwriteExisting = false) {
    const wrote = await this.primary.copyFile(fromKey, toKey, overwriteExisting);
    if (wrote) {
      d(`Mirroring copy of '${fromKey}' to '${toKey}' on the secondary store`);
      await this.mirrorCopy(fromKey, toKey);
    } else if (!await this.secondary.hasFile(toKey)) {
      const primaryData = await this.primary.getFile(toKey);
      if (primaryData.length > 0) {
        console.log(JSON.stringify({
          message: 'Healing object missing from the secondary store',
          key: toKey,
        }));
        await this.mirrorWrite(toKey, primaryData);
      }
    }
    return wrote;
  }

  /**
   * A copy on the secondary only works if the secondary already holds the source, which a mirror
   * that has drifted may not, so a copy that will not go through falls back to sending the bytes
   * the primary now has rather than reporting drift over something recoverable.
   */
  private async mirrorCopy(fromKey: string, toKey: string) {
    for (let attempt = 1; attempt <= this.mirrorWriteAttempts; attempt += 1) {
      try {
        await this.secondary.copyFile(fromKey, toKey, true);
        return;
      } catch (err) {
        if (attempt < this.mirrorWriteAttempts) {
          await sleep(this.mirrorRetryDelayMs * attempt);
          continue;
        }
        d(`Copy on the secondary store failed, mirroring the primary's bytes for '${toKey}' instead`);
      }
    }
    await this.mirrorWrite(toKey, await this.primary.getFile(toKey));
  }

  private async mirrorWrite(key: string, data: Buffer) {
    for (let attempt = 1; attempt <= this.mirrorWriteAttempts; attempt += 1) {
      try {
        await this.secondary.putFile(key, await this.dataForSecondary(key, data), true);
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
