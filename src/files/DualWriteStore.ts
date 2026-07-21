import debug from 'debug';

const d = debug('nucleus:dual-write');

/**
 * Mirrors every write to a secondary file store while serving all reads from
 * the primary.  Used during the S3 -> R2 transition so both backends stay
 * current and either can be served (or rolled back to) at any time.
 *
 * A write is only mirrored when the primary actually wrote, and always with
 * overwrite enabled, so the secondary converges to whatever the primary
 * accepted.  A putFile skipped because the key already exists in the primary
 * is not mirrored -- pre-existing objects are the bulk copy's responsibility.
 * Secondary failures propagate rather than being swallowed: silent drift
 * between the stores is worse than a retryable error.
 */
export default class DualWriteStore implements IFileStore {
  constructor(public primary: IFileStore, public secondary: IFileStore) {}

  public async putFile(key: string, data: Buffer, overwriteExisting = false) {
    const wrote = await this.primary.putFile(key, data, overwriteExisting);
    if (wrote) {
      d(`Mirroring write of '${key}' to the secondary store`);
      await this.secondary.putFile(key, data, true);
    }
    return wrote;
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
