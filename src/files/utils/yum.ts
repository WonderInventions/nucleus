import * as cp from 'child-process-promise';
import * as fs from 'fs/promises';
import * as path from 'path';
import debug from 'debug';

import { packagesForLinuxRepo } from './linux-packages';
import { spawnPromiseAndCapture, escapeShellArguments } from './spawn';
import { syncDirectoryToStore } from './sync';
import { withTmpDir } from './tmp';
import * as config from '../../config';

const d = debug(`nucleus:files:yum`);

// Everything createrepo writes lands here; the packages sit beside it and must not be re-uploaded
const YUM_METADATA_DIR = 'repodata';

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const getCreateRepoCommand = (dir: string, args: string[]): [string, string[]] => {
  if (process.platform === 'linux') {
    return ['createrepo_c', args];
  }
  return [
    'docker',
    ['run', '--rm', '-v', `${dir}:/root`, 'tomologic/createrepo', ...args],
  ];
};

const getSignRpmCommand = (dir: string, args: string[]): [string, string[]] => {
  if (process.platform === 'linux') {
    return ['rpmsign', args];
  }
  const safeArgs = escapeShellArguments(args);
  return [
    'docker',
    ['run', '--rm', '-v', `${dir}:/root/working`, 'marshallofsound/sh', `(gpg-agent --daemon) && (gpg --import key.asc || true) && (rpmsign ${safeArgs.join(' ')})`],
  ];
};

const createRepoFile = async (store: IFileStore, app: NucleusApp, channel: NucleusChannel) => {
  await store.putFile(
    path.posix.join(app.slug, channel.id!, 'linux', `${app.slug}.repo`),
    Buffer.from(
`[packages]
name=${app.name} Packages
baseurl=${await store.getPublicBaseUrl()}/${app.slug}/${channel.id!}/linux/redhat
enabled=1
gpgcheck=1`,
    ),
    true,
  );
};

const signRpm = async (rpm: string) => {
  await withTmpDir(async (tmpDir) => {
    const fileName = path.basename(rpm);
    const tmpFile = path.resolve(tmpDir, fileName);
    await fs.copyFile(rpm, tmpFile);
    // Import GPG key
    const key = path.resolve(tmpDir, 'key.asc');
    await fs.writeFile(key, config.gpgSigningKey);
    const [stdout, stderr] = await spawnPromiseAndCapture('gpg', ['--import', key]);

    const keyImport = stdout.toString() + '--' + stderr.toString();
    const keyMatch = keyImport.match(/ key ([A-Za-z0-9]+):/);
    if (!keyMatch || !keyMatch[1]) {
      console.error(JSON.stringify(keyImport));
      throw new Error('Bad GPG import');
    }
    const keyId = keyMatch[1];
    // Sign the RPM file
    const [exe, args] = getSignRpmCommand(tmpDir, ['-D', `_gpg_name ${keyId}`, '--addsign', path.basename(rpm)]);
    const [signOut, signErr, signError] = await spawnPromiseAndCapture(exe, args, {
      cwd: tmpDir,
    });
    if (signError) {
      console.error('Failed to sign RPM file');
      console.error(`Output:\n${signOut.toString()}\n\n${signErr.toString()}`);
      throw signError;
    }
    // Done signing
    await fs.copyFile(tmpFile, rpm);
  });
};

export const getYumPackageKey = (app: NucleusApp, channel: NucleusChannel, versionName: string, fileName: string) =>
  path.posix.join(app.slug, channel.id!, 'linux', 'redhat', `${versionName}-${fileName}`);

/**
 * Stages the packages the repo advertises, minus one the caller is about to write itself.
 *
 * Everything in the pool was signed on its way in, so nothing staged here is re-signed: signing
 * rewrites the rpm, which would change the published bytes of packages that shipped weeks ago.
 */
const stageAdvertisedRpms = async (
  store: IFileStore,
  app: NucleusApp,
  channel: NucleusChannel,
  tmpDir: string,
  exclude?: { versionName: string; fileName: string },
) => {
  for (const pkg of packagesForLinuxRepo(channel, '.rpm')) {
    if (exclude && pkg.versionName === exclude.versionName && pkg.fileName === exclude.fileName) continue;
    const packageKey = getYumPackageKey(app, channel, pkg.versionName, pkg.fileName);
    // A file can be registered against the version before its package reaches the store, and the
    // store reports the missing key as an empty buffer, which createrepo rejects
    if (await store.getFileSize(packageKey)) {
      await fs.writeFile(path.resolve(tmpDir, `${pkg.versionName}-${pkg.fileName}`), await store.getFile(packageKey));
    }
  }
};

/**
 * Rebuild the yum repo metadata from the packages that should currently be
 * advertised, without adding anything.  Used after deleting packages so the
 * metadata never advertises files that no longer exist.
 */
export const regenerateYumMetadata = async (store: IFileStore, app: NucleusApp, channel: NucleusChannel) => {
  await withTmpDir(async (tmpDir) => {
    const storeKey = path.posix.join(app.slug, channel.id!, 'linux', 'redhat');
    await fs.mkdir(`${tmpDir}/repodata`, { recursive: true });

    await stageAdvertisedRpms(store, app, channel, tmpDir);

    d(`Regenerating repo metadata`);
    const [exe, args] = getCreateRepoCommand(tmpDir, ['-v', '--no-database', './']);
    await cp.spawn(exe, args, {
      cwd: tmpDir,
    });
    await syncDirectoryToStore(store, storeKey, tmpDir, YUM_METADATA_DIR);
    await createRepoFile(store, app, channel);
  });
};

export const initializeYumRepo = async (store: IFileStore, app: NucleusApp, channel: NucleusChannel) => {
  await withTmpDir(async (tmpDir) => {
    const [exe, args] = getCreateRepoCommand(tmpDir, ['-v', '--no-database', './']);
    await cp.spawn(exe, args, {
      cwd: tmpDir,
    });
    await syncDirectoryToStore(
      store,
      path.posix.join(app.slug, channel.id!, 'linux', 'redhat'),
      tmpDir,
    );
    await createRepoFile(store, app, channel);
  });
};

export const addFileToYumRepo = async (store: IFileStore, {
  app,
  channel,
  internalVersion,
  file,
  fileData,
}: HandlePlatformUploadOpts) => {
  await withTmpDir(async (tmpDir) => {
    const storeKey = path.posix.join(app.slug, channel.id!, 'linux', 'redhat');
    // Copy the XML files in repodata/
    await fs.mkdir(`${tmpDir}/repodata`, { recursive: true });
    await stageAdvertisedRpms(store, app, channel, tmpDir, {
      versionName: internalVersion.name,
      fileName: file.fileName,
    });

    const binaryPath = path.resolve(tmpDir, `${internalVersion.name}-${file.fileName}`);
    if (await pathExists(binaryPath)) {
      throw new Error('Uploaded a duplicate file');
    }
    await fs.writeFile(binaryPath, fileData);
    d(`Signing ${binaryPath}`);
    await signRpm(binaryPath);

    d(`Updating repo`);
    const [exe, args] = getCreateRepoCommand(tmpDir, ['-v', '--update', '--no-database', '--deltas', './']);
    await cp.spawn(exe, args, {
      cwd: tmpDir,
    });

    // Signing rewrote the file, so the pool has to receive what was actually indexed.  Written
    // before the metadata that references it, so a failure in between leaves an unadvertised
    // package rather than metadata pointing at a key that 404s
    await store.putFile(
      getYumPackageKey(app, channel, internalVersion.name, file.fileName),
      await fs.readFile(binaryPath),
      true,
    );
    await syncDirectoryToStore(store, storeKey, tmpDir, YUM_METADATA_DIR);
    d(`Creating repo file`);
    await createRepoFile(store, app, channel);
  });
};
