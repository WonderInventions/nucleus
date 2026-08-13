import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import debug from 'debug';
import * as path from 'path';
import * as semver from 'semver';

import { initializeAptRepo, addDebToPool, getAptPackageKey, regenerateAptMetadata } from './utils/apt';
import { PendingLinuxRepos } from './utils/linux-packages';
import { initializeYumRepo, addRpmToPool, getYumPackageKey, regenerateYumMetadata } from './utils/yum';
import { updateDarwinReleasesFiles } from './utils/darwin';
import { updateWin32ReleasesFiles } from './utils/win32';

const VALID_WINDOWS_SUFFIX = ['-full.nupkg', '-delta.nupkg', '.exe', '.msi'];
const VALID_DARWIN_SUFFIX = ['.dmg', '.zip', '.pkg'];
const CIPHER_MODE = 'aes-256-ctr';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_SALT = process.env.NUCLEUS_SCRYPT_SALT || 'nucleus-temp-file';

const d = debug('nucleus:positioner');

type PositionerLock = string;

export default class Positioner {
  private store: IFileStore;
  private pendingLinuxRepos: PendingLinuxRepos = { apt: false, yum: false };

  constructor(store: IFileStore) {
    this.store = store;
  }

  /**
   * Note: We encrypt the temporary files here so that no one can access them, they
   * are potentially available on a public facing bucket.  We recognize this is a
   * lot of computation but for safety reasons we must ensure that these files can't
   * accidentally (or malicously) be accessed by third parties 
   */
  public async saveTemporaryFile(app: NucleusApp, saveString: string, fileName: string, data: Buffer, cipherPassword: string) {
    d(`Saving temporary file: ${saveString}/${fileName} for app: ${app.slug}`);
    const storeKey = path.join(app.slug, 'temp', saveString, fileName);
    const derivedKey = crypto.scryptSync(cipherPassword, SCRYPT_SALT, KEY_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(CIPHER_MODE, derivedKey, iv);
    const cryptedBuffer = Buffer.concat([iv, cipher.update(data), cipher.final()]);
    await this.store.putFile(storeKey, cryptedBuffer);
  }

  public async getTemporaryFile(app: NucleusApp, saveString: string, fileName: string, cipherPassword: string) {
    d(`Fetching temporary file: ${saveString}/${fileName} for app: ${app.slug}`);
    const storeKey = path.join(app.slug, 'temp', saveString, fileName);
    const derivedKey = crypto.scryptSync(cipherPassword, SCRYPT_SALT, KEY_LENGTH);
    const raw = await this.store.getFile(storeKey);
    const iv = raw.subarray(0, IV_LENGTH);
    const data = raw.subarray(IV_LENGTH);
    const decipher = crypto.createDecipheriv(CIPHER_MODE, derivedKey, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  public async cleanUpTemporaryFile(lock: PositionerLock, app: NucleusApp, channel: NucleusChannel, saveString: string) {
    if (lock !== await this.currentLock(app, channel)) return;
    d(`Deleting all temporary files for app: ${app.slug} in save ID: ${saveString}`);
    await this.store.deletePath(path.join(app.slug, 'temp', saveString));
  }

  /**
   * Delete every stored file for versions that have been deleted from the database:
   * the _index tree, win32/darwin artifacts and the linux apt/yum package files.
   *
   * The apt/yum repo metadata is not touched here: it is regenerated from only
   * non-dead versions on every linux upload, and only dead versions can be
   * deleted, so the metadata no longer references these package files.
   */
  public async cleanUpDeletedVersionFiles(lock: PositionerLock, app: NucleusApp, channel: NucleusChannel, versions: NucleusVersion[]): Promise<boolean> {
    if (lock !== await this.currentLock(app, channel)) {
      console.warn(JSON.stringify({
        message: 'Skipped deleting stored files for deleted versions, the given lock is not current',
        app: app.slug,
        channel: channel.id,
        versions: versions.map(v => v.name),
      }));
      return false;
    }
    let deletedDeb = false;
    let deletedRpm = false;
    for (const version of versions) {
      const paths = [path.posix.join(app.slug, channel.id!, '_index', version.name)];

      for (const file of version.files || []) {
        switch (file.platform) {
          case 'win32':
          case 'darwin':
            paths.push(path.posix.join(app.slug, channel.id!, file.platform, file.arch, file.fileName));
            break;
          case 'linux':
            if (file.fileName.endsWith('.deb')) {
              paths.push(getAptPackageKey(app, channel, version.name, file.fileName));
              deletedDeb = true;
            } else if (file.fileName.endsWith('.rpm')) {
              paths.push(getYumPackageKey(app, channel, version.name, file.fileName));
              deletedRpm = true;
            }
            break;
          default:
            break;
        }
      }

      console.log(JSON.stringify({
        message: 'Deleting stored files for deleted version',
        app: app.slug,
        channel: channel.id,
        version: version.name,
        paths,
      }));
      for (const deletePath of paths) {
        await this.store.deletePath(deletePath);
      }
    }

    // The repo metadata may still advertise a deleted package (e.g. when no
    // linux upload has happened since the version died), so rebuild it from
    // the surviving non-dead versions to prevent apt/dnf clients resolving
    // package entries that would now 404
    if (deletedDeb || deletedRpm) {
      console.log(JSON.stringify({
        message: 'Regenerating linux repo metadata after deleting packages',
        app: app.slug,
        channel: channel.id,
        apt: deletedDeb,
        yum: deletedRpm,
      }));
      if (deletedDeb) {
        await this.regenerateAptRepo(app, channel);
      }
      if (deletedRpm) {
        await this.regenerateYumRepo(app, channel);
      }
    }
    return true;
  }

  public regenerateAptRepo = async (app: NucleusApp, channel: NucleusChannel) => {
    await regenerateAptMetadata(this.store, app, channel);
  }

  public regenerateYumRepo = async (app: NucleusApp, channel: NucleusChannel) => {
    await regenerateYumMetadata(this.store, app, channel);
  }

  /**
   * Publish the linux packages positioned under this lock.
   *
   * handleUpload only puts a package in the pool, so every release has to end here or the
   * packages it positioned stay unadvertised.  Rebuilding once, after they are all in the pool,
   * is also what stops a release publishing the states in between -- a repo advertising one
   * architecture of a version whose other architecture has not landed yet.
   *
   * Which repos to rebuild is tracked as packages are positioned rather than passed in, so a
   * caller cannot rebuild the wrong ones, and releaseLock can say so when a caller does not get
   * here at all.  The channel must be the one re-read after the version's files were registered:
   * the metadata is built from it, and a stale copy would advertise the previous release.
   */
  public regenerateLinuxRepos = async (lock: PositionerLock, app: NucleusApp, channel: NucleusChannel) => {
    const repos = this.pendingLinuxRepos;
    if (!repos.apt && !repos.yum) return;
    if (lock !== await this.currentLock(app, channel)) return;
    if (repos.apt) {
      await this.regenerateAptRepo(app, channel);
    }
    if (repos.yum) {
      await this.regenerateYumRepo(app, channel);
    }
    // Cleared last, so a rebuild that throws leaves the packages marked unadvertised and
    // releaseLock reports them
    this.pendingLinuxRepos = { apt: false, yum: false };
  }

  /**
   * Handle the upload / release of a given file for a given version.  This will do a few things
   *
   * * Position the file at the correct place for the given OS and update the required metadata
   * * Add the file to the _index for the given app/channel/version
   * * Copy the file to the "latest" position if it is semantically the latest release at 100% rollout
   */
  public async handleUpload(lock: PositionerLock, {
    app,
    channel,
    internalVersion,
    file,
    fileData,
  }: {
    app: NucleusApp;
    channel: NucleusChannel;
    internalVersion: NucleusVersion,
    file: NucleusFile;
    fileData: Buffer;
  }) {
    // Validate arch
    if (lock !== await this.currentLock(app, channel)) return;
    if (file.arch !== 'ia32' && file.arch !== 'x64' && file.arch !== 'arm64') return;
    d(`Handling upload (${file.fileName}) for app (${app.slug}) and channel (${channel.name}) for version (${internalVersion.name}) on platform/arch (${file.platform}/${file.arch})`);

    if (!process.env.NO_NUCLEUS_INDEX) {
      // Insert into file index for retreival later, this is purely to avoid making assumptions
      // about file lifetimes for all platforms or assumptions about file positions or assumptions
      // about file names containing version strings (which are currently enforced but may not be
      // in the future)
      await this.store.putFile(this.getIndexKey(app, channel, internalVersion, file), fileData);
    }

    switch (file.platform) {
      case 'win32':
        await this.handleWindowsUpload({ app, channel, internalVersion, file, fileData });
        break;
      case 'darwin':
        await this.handleDarwinUpload({ app, channel, internalVersion, file, fileData });
        break;
      case 'linux':
        await this.handleLinuxUpload({ app, channel, internalVersion, file, fileData });
        break;
      default:
        return;
    }
  }

  public getIndexKey(app: NucleusApp, channel: NucleusChannel, version: NucleusVersion, file: NucleusFile) {
    return path.posix.join(app.slug, channel.id!, '_index', version.name, file.platform, file.arch, file.fileName);
  }

  public getLatestKey(app: NucleusApp, channel: NucleusChannel, version: NucleusVersion, file: NucleusFile) {
    const ext = path.extname(file.fileName);
    return path.posix.join(app.slug, channel.id!, 'latest', file.platform, file.arch, `${app.name}${ext}`);
  }

  /**
   * Given a version for an app / channel check if any of the files should be uploaded to the "latest"
   * positioning.  This will only occur if the rollout is 100 and the version is the "latest" according
   * to semver.
   */
  public async potentiallyUpdateLatestInstallers(lock: PositionerLock, app: NucleusApp, channel: NucleusChannel) {
    if (lock !== await this.currentLock(app, channel)) return;

    const latestThings: {
      [latestKey: string]: {
        indexKey: string;
        version: string;
      };
    } = {};
    const rolledOutVersions = channel.versions.filter(v => v.rollout === 100 && !v.dead);

    for (const version of rolledOutVersions.sort((a, b) => semver.compare(a.name, b.name))) {
      for (const file of version.files) {
        if (file.type !== 'installer') continue;

        const latestKey = this.getLatestKey(app, channel, version, file);
        const indexKey = this.getIndexKey(app, channel, version, file);

        latestThings[latestKey] = {
          indexKey,
          version: version.name,
        };
      }
    }

    for (const latestKey in latestThings) {
      const latestThing = latestThings[latestKey];
      await this.copyFile(latestThing.indexKey, latestKey, latestThing.version);
    }
  }

  /**
   * It is assumed the called has a validated lock
   */
  private async copyFile(fromKey: string, toKey: string, ref = '') {
    const refKey = `${toKey}.ref`;
    if (!ref || (await this.store.getFile(refKey)).toString() !== ref) {
      // The stores report a missing object as an empty buffer, so a version
      // carrying a file that was never positioned would otherwise replace a
      // good installer with a zero byte one
      if (!await this.store.hasFile(fromKey)) {
        console.warn(JSON.stringify({
          message: 'Skipped publishing a latest installer, the indexed file it copies from is missing',
          from: fromKey,
          to: toKey,
        }));
        return;
      }
      await this.store.putFile(
        toKey,
        await this.store.getFile(fromKey),
        true,
      );
      await this.store.putFile(
        refKey,
        Buffer.from(ref),
        true,
      );
    }
  }

  public updateWin32ReleasesFiles = async (lock: PositionerLock, app: NucleusApp, channel: NucleusChannel, arch: string) => {
    if (lock !== await this.currentLock(app, channel)) return;
    let cachedFileSizes = new Map<string, number>();
    return await updateWin32ReleasesFiles({
      app,
      channel,
      arch,
      store: this.store,
      positioner: this,
      cachedFileSizes,
    });
  }

  protected async handleWindowsUpload({
    app,
    channel,
    file,
    fileData,
  }: HandlePlatformUploadOpts) {
    const root = path.posix.join(app.slug, channel.id!, 'win32', file.arch);
    const key = path.posix.join(root, file.fileName);
    if (!VALID_WINDOWS_SUFFIX.some(suffix => file.fileName.endsWith(suffix))) {
      d(`Attempted to upload a file for win32 but it had an invalid suffix: ${file.fileName}`);
      return;
    }

    if (await this.store.putFile(key, fileData) && file.fileName.endsWith('.nupkg')) {
      d('Pushed a nupkg file to the file store so appending release information to RELEASES');
      let cachedFileSizes = new Map<string, number>();
      await updateWin32ReleasesFiles({ app, channel, arch: file.arch, store: this.store, positioner: this, cachedFileSizes });
    }
  }

  public updateDarwinReleasesFiles = async (lock: PositionerLock, app: NucleusApp, channel: NucleusChannel, arch: string) => {
    if (lock !== await this.currentLock(app, channel)) return;
    return await updateDarwinReleasesFiles({
      app,
      channel,
      arch,
      store: this.store,
    });
  }

  protected async handleDarwinUpload({
    app,
    channel,
    internalVersion,
    file,
    fileData,
  }: HandlePlatformUploadOpts) {
    const root = path.posix.join(app.slug, channel.id!, 'darwin', file.arch);
    const fileKey = path.posix.join(root, file.fileName);
    if (!VALID_DARWIN_SUFFIX.some(suffix => file.fileName.endsWith(suffix))) {
      d(`Attempted to upload a file for darwin but it had an invalid suffix: ${file.fileName}`);
      return;
    }

    if (await this.store.putFile(fileKey, fileData) && file.fileName.endsWith('.zip')) {
      d('Pushed a zip file to the file store so updating release information in RELEASES.json');
      await updateDarwinReleasesFiles({ app, channel, arch: file.arch, store: this.store });
    }
  }

  protected async handleLinuxUpload({
    app,
    channel,
    internalVersion,
    file,
    fileData,
  }: HandlePlatformUploadOpts) {
    if (file.fileName.endsWith('.rpm')) {
      d('Adding rpm file to the yum package pool');
      await addRpmToPool(this.store, { app, channel, file, fileData, internalVersion });
      this.pendingLinuxRepos.yum = true;
    } else if (file.fileName.endsWith('.deb')) {
      d('Adding deb file to the apt package pool');
      await addDebToPool(this.store, { app, channel, file, fileData, internalVersion });
      this.pendingLinuxRepos.apt = true;
    } else {
      console.warn('Will not upload unknown linux file');
    }
  }

  private lockKey(app: NucleusApp, channel: NucleusChannel) {
    return path.posix.join(app.slug, channel.id!, '.lock');
  }

  /**
   * Don't use unless you know what you're doing
   */
  public currentLock = async (app: NucleusApp, channel: NucleusChannel) => {
    const lockFile = this.lockKey(app, channel);
    return (await this.store.getFile(lockFile)).toString('utf8');
  }

  public requestLock = async (app: NucleusApp, channel: NucleusChannel): Promise<PositionerLock | null> => {
    const lockFile = this.lockKey(app, channel);
    const lock = randomUUID();
    const currentLock = (await this.store.getFile(lockFile)).toString('utf8');
    if (currentLock === '') {
      await this.store.putFile(lockFile, Buffer.from(lock), true);
      return lock;
    }
    return null;
  }

  public releaseLock = async (app: NucleusApp, channel: NucleusChannel, lock: PositionerLock) => {
    // Nothing downstream will pick these up: the packages are in the pool and the metadata that
    // should advertise them was never rebuilt, so they stay invisible until some later release
    // happens to rebuild the same repo
    if (this.pendingLinuxRepos.apt || this.pendingLinuxRepos.yum) {
      console.error(JSON.stringify({
        message: 'Released the channel lock with linux packages that were never advertised',
        app: app.slug,
        channel: channel.id,
        ...this.pendingLinuxRepos,
      }));
      this.pendingLinuxRepos = { apt: false, yum: false };
    }
    const lockFile = this.lockKey(app, channel);
    const currentLock = (await this.store.getFile(lockFile)).toString('utf8');
    if (currentLock === lock) {
      await this.store.deletePath(lockFile);
    }
  }

  public withLock = async (app: NucleusApp, channel: NucleusChannel, fn: (lock: PositionerLock) => Promise<void>): Promise<boolean> => {
    const lock = await this.requestLock(app, channel);
    if (!lock) return false;
    try {
      await fn(lock);
    } catch (err) {
      await this.releaseLock(app, channel, lock);
      throw err;
    }
    await this.releaseLock(app, channel, lock);
    return true;
  }

  public initializeStructure = async (app: NucleusApp, channel: NucleusChannel) => {
    if (process.platform === 'linux') {
      await initializeYumRepo(this.store, app, channel);
      await initializeAptRepo(this.store, app, channel);
    }
    await this.store.putFile(path.posix.join(app.slug, channel.id!, 'versions.json'), Buffer.from(JSON.stringify([])));
  }
}
