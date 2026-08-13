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
 * Adds an rpm to the pool the repo metadata is built from.  Advertising it is a separate step, so
 * that a release positions every package before any of them reaches the published metadata.
 *
 * Signing happens here, on the way in, which is what lets a rebuild leave the packages it stages
 * alone: signing rewrites the rpm, so re-signing one would change the published bytes of a
 * package that shipped weeks ago.
 */
export const addRpmToPool = async (store: IFileStore, {
  app,
  channel,
  internalVersion,
  file,
  fileData,
}: HandlePlatformUploadOpts) => {
  const signedData = await withTmpDir(async (tmpDir) => {
    const rpmPath = path.resolve(tmpDir, `${internalVersion.name}-${file.fileName}`);
    await fs.writeFile(rpmPath, fileData);
    d(`Signing ${rpmPath}`);
    await signRpm(rpmPath);
    return await fs.readFile(rpmPath);
  });
  await store.putFile(getYumPackageKey(app, channel, internalVersion.name, file.fileName), signedData, true);
};

const stageAdvertisedRpms = async (
  store: IFileStore,
  app: NucleusApp,
  channel: NucleusChannel,
  tmpDir: string,
) => {
  for (const pkg of packagesForLinuxRepo(channel, '.rpm')) {
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

