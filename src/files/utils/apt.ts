import * as cp from 'child-process-promise';
import * as fs from 'fs/promises';
import * as path from 'path';

import { gpgSign, gpgSignInline } from './gpg';
import { packagesForLinuxRepo } from './linux-packages';
import { syncFilesToStore } from './sync';
import { withTmpDir } from './tmp';
import * as config from '../../config';

// Everything writeAptMetadata generates.  Named rather than derived because the debs it indexes
// sit in the same directory and must not be re-uploaded alongside it
const APT_METADATA_FILES = [
  'binary/Packages',
  'binary/Packages.gz',
  'binary/Sources',
  'binary/Sources.gz',
  'binary/Release',
  'binary/Release.gpg',
  'binary/InRelease',
];

const getScanPackagesCommand = (dir: string, args: string[]): [string, string[]] => {
  if (process.platform === 'linux') {
    return ['dpkg-scanpackages', args];
  }
  return [
    'docker',
    ['run', '--rm', '-v', `${dir}:/root`, 'marshallofsound/dpkg-scanpackages', ...args],
  ];
};

const getScanSourcesCommand = (dir: string, args: string[]): [string, string[]] => {
  if (process.platform === 'linux') {
    return ['dpkg-scansources', args];
  }
  return [
    'docker',
    ['run', '--rm', '-v', `${dir}:/root`, 'marshallofsound/dpkg-scansources', ...args],
  ];
};

const spawnAndGzip = async ([command, args]: [string, string[]], cwd: string): Promise<[Buffer, Buffer]> => {
  const result = await cp.spawn(command, args, {
    cwd,
    capture: ['stdout'],
  });
  const output: Buffer = result.stdout;
  return await withTmpDir(async (tmpDir: string) => {
    await fs.writeFile(path.resolve(tmpDir, 'file'), output);
    await cp.spawn('gzip', ['-9', 'file'], {
      cwd: tmpDir,
      capture: ['stdout'],
    });
    const content = await fs.readFile(path.resolve(tmpDir, 'file.gz'));
    return [output, content] as [Buffer, Buffer];
  });
};

const getAptFtpArchiveCommand = (dir: string, args: string[]): [string, string[]] => {
  if (process.platform === 'linux') {
    return ['apt-ftparchive', args];
  }
  return [
    'docker',
    ['run', '--rm', '-v', `${dir}:/root`, 'marshallofsound/apt-ftparchive', ...args],
  ];
};

const generateReleaseFile = async (tmpDir: string, app: NucleusApp) => {
  const configFile = path.resolve(tmpDir, 'Release.conf');
  await fs.writeFile(configFile, `APT::FTPArchive::Release::Origin "${config.organization || 'Nucleus'}";
APT::FTPArchive::Release::Label "${app.name}";
APT::FTPArchive::Release::Suite "stable";
APT::FTPArchive::Release::Codename "binary";
APT::FTPArchive::Release::Architectures "amd64 arm64";
APT::FTPArchive::Release::Components "main";
APT::FTPArchive::Release::Description "${app.name}";`);
  const [exe, args] = getAptFtpArchiveCommand(tmpDir, ['-c=Release.conf', 'release', '.']);
  const { stdout } = await cp.spawn(exe, args, {
    cwd: path.resolve(tmpDir),
    capture: ['stdout', 'stderr'],
  });
  await fs.writeFile(path.resolve(tmpDir, 'Release'), stdout);
  await gpgSign(path.resolve(tmpDir, 'Release'), path.resolve(tmpDir, 'Release.gpg'));
  await gpgSignInline(path.resolve(tmpDir, 'Release'), path.resolve(tmpDir, 'InRelease'));
  await fs.rm(configFile, { force: true });
};

const writeAptMetadata = async (tmpDir: string, app: NucleusApp) => {
  const packagesContent = await spawnAndGzip(getScanPackagesCommand(tmpDir, ['--multiversion', 'binary', '/dev/null']), tmpDir);
  await fs.writeFile(path.resolve(tmpDir, 'binary', 'Packages'), packagesContent[0]);
  await fs.writeFile(path.resolve(tmpDir, 'binary', 'Packages.gz'), packagesContent[1]);
  const sourcesContent = await spawnAndGzip(getScanSourcesCommand(tmpDir, ['binary', '/dev/null']), tmpDir);
  await fs.writeFile(path.resolve(tmpDir, 'binary', 'Sources'), sourcesContent[0]);
  await fs.writeFile(path.resolve(tmpDir, 'binary', 'Sources.gz'), sourcesContent[1]);
  await generateReleaseFile(path.resolve(tmpDir, 'binary'), app);
};

export const getAptPackageKey = (app: NucleusApp, channel: NucleusChannel, versionName: string, fileName: string) =>
  path.posix.join(app.slug, channel.id!, 'linux', 'debian', 'binary', `${versionName}-${fileName}`);

/**
 * Adds a deb to the pool the repo metadata is built from.  Advertising it is a separate step, so
 * that a release positions every package before any of them reaches the published metadata.
 */
export const addDebToPool = async (store: IFileStore, {
  app,
  channel,
  internalVersion,
  file,
  fileData,
}: HandlePlatformUploadOpts) => {
  await store.putFile(getAptPackageKey(app, channel, internalVersion.name, file.fileName), fileData, true);
};

const stageAdvertisedDebs = async (
  store: IFileStore,
  app: NucleusApp,
  channel: NucleusChannel,
  tmpDir: string,
) => {
  for (const pkg of packagesForLinuxRepo(channel, '.deb')) {
    const packageKey = getAptPackageKey(app, channel, pkg.versionName, pkg.fileName);
    // A file can be registered against the version before its package
    // reaches the store, and the store reports the missing key as an
    // empty buffer, which dpkg-scanpackages rejects
    if (await store.getFileSize(packageKey)) {
      await fs.writeFile(`${tmpDir}/binary/${pkg.versionName}-${pkg.fileName}`, await store.getFile(packageKey));
    }
  }
};

/**
 * Rebuild the apt repo metadata from the packages that should currently be
 * advertised, without adding anything.  Used after deleting packages so the
 * metadata never advertises files that no longer exist.
 */
export const regenerateAptMetadata = async (store: IFileStore, app: NucleusApp, channel: NucleusChannel) => {
  await withTmpDir(async (tmpDir) => {
    const storeKey = path.posix.join(app.slug, channel.id!, 'linux', 'debian');
    await fs.mkdir(path.resolve(tmpDir, 'binary'), { recursive: true });

    await stageAdvertisedDebs(store, app, channel, tmpDir);

    await writeAptMetadata(tmpDir, app);
    await syncFilesToStore(store, storeKey, tmpDir, APT_METADATA_FILES);
  });
};

export const initializeAptRepo = async (store: IFileStore, app: NucleusApp, channel: NucleusChannel) => {
  await withTmpDir(async (tmpDir) => {
    await fs.mkdir(path.resolve(tmpDir, 'binary'), { recursive: true });
    await writeAptMetadata(tmpDir, app);
    await syncFilesToStore(
      store,
      path.posix.join(app.slug, channel.id!, 'linux', 'debian'),
      tmpDir,
      APT_METADATA_FILES,
    );
  });
};

