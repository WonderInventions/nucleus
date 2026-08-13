import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { packagesForLinuxRepo, readPackageFromPool } from '../linux-packages';

const file = (fileName: string, platform: NucleusPlatform = 'linux', arch = 'x64'): NucleusFile => ({
  fileName,
  arch,
  platform,
  type: 'installer',
  sha1: '',
  sha256: '',
});

const version = (name: string, files: NucleusFile[], dead = false): NucleusVersion => ({
  name,
  dead,
  rollout: 100,
  files,
});

const channel = (versions: NucleusVersion[]): NucleusChannel => ({
  id: 'fake_channel_id',
  name: 'Fake',
  versions,
});

describe('packagesForLinuxRepo', () => {
  it('should advertise nothing for a channel with no versions', () => {
    assert.deepStrictEqual(packagesForLinuxRepo(channel([]), '.deb'), []);
  });

  it('should advertise nothing when no version carries a package of that kind', () => {
    const versions = [version('1.0.0', [file('app.deb'), file('app.zip', 'darwin')])];

    assert.deepStrictEqual(packagesForLinuxRepo(channel(versions), '.rpm'), []);
  });

  it('should advertise every arch of the newest version, not just one', () => {
    const versions = [
      version('1.0.0', [file('app-1.0.0.x86_64.rpm', 'linux', 'x64')]),
      version('1.1.0', [
        file('app-1.1.0.x86_64.rpm', 'linux', 'x64'),
        file('app-1.1.0.arm64.rpm', 'linux', 'arm64'),
      ]),
    ];

    assert.deepStrictEqual(packagesForLinuxRepo(channel(versions), '.rpm'), [
      { versionName: '1.1.0', fileName: 'app-1.1.0.x86_64.rpm' },
      { versionName: '1.1.0', fileName: 'app-1.1.0.arm64.rpm' },
    ]);
  });

  it('should pass over a newer version that carries no package of that kind', () => {
    const versions = [
      version('1.0.0', [file('app_1.0.0_amd64.deb')]),
      // A release that shipped without linux builds must not blank the repo
      version('1.1.0', [file('app-1.1.0.exe', 'win32')]),
    ];

    assert.deepStrictEqual(packagesForLinuxRepo(channel(versions), '.deb'), [
      { versionName: '1.0.0', fileName: 'app_1.0.0_amd64.deb' },
    ]);
  });

  it('should ignore dead versions even when they are newest', () => {
    const versions = [
      version('1.0.0', [file('app_1.0.0_amd64.deb')]),
      version('1.1.0', [file('app_1.1.0_amd64.deb')], true),
    ];

    assert.deepStrictEqual(packagesForLinuxRepo(channel(versions), '.deb'), [
      { versionName: '1.0.0', fileName: 'app_1.0.0_amd64.deb' },
    ]);
  });

  it('should ignore packages of the other kind on the version it picks', () => {
    const versions = [
      version('1.0.0', [file('app_1.0.0_amd64.deb'), file('app-1.0.0.x86_64.rpm')]),
    ];

    assert.deepStrictEqual(packagesForLinuxRepo(channel(versions), '.deb'), [
      { versionName: '1.0.0', fileName: 'app_1.0.0_amd64.deb' },
    ]);
  });

  it('should ignore a matching extension on a non-linux file', () => {
    const versions = [version('1.0.0', [file('app_1.0.0_amd64.deb', 'darwin')])];

    assert.deepStrictEqual(packagesForLinuxRepo(channel(versions), '.deb'), []);
  });

  it('should pick by semver rather than the order versions arrive in', () => {
    const versions = [
      version('1.10.0', [file('app_1.10.0_amd64.deb')]),
      version('1.9.0', [file('app_1.9.0_amd64.deb')]),
    ];

    assert.deepStrictEqual(packagesForLinuxRepo(channel(versions), '.deb'), [
      { versionName: '1.10.0', fileName: 'app_1.10.0_amd64.deb' },
    ]);
  });

  // The release channels name every version with a prerelease suffix, so the suffix is the only
  // thing separating two builds of one version and cannot be compared away
  it('should rank prerelease suffixes rather than treating them as equal', () => {
    const versions = [
      version('227.2.0-alpha001', [file('roamalpha_227.2.0-alpha001_amd64.deb')]),
      version('227.2.0-alpha002', [file('roamalpha_227.2.0-alpha002_amd64.deb')]),
    ];

    assert.deepStrictEqual(packagesForLinuxRepo(channel(versions), '.deb'), [
      { versionName: '227.2.0-alpha002', fileName: 'roamalpha_227.2.0-alpha002_amd64.deb' },
    ]);
  });
});

describe('readPackageFromPool', () => {
  const poolStore = (size: number, data: Buffer | Error): IFileStore => ({
    getFileSize: async () => size,
    getFile: async () => {
      if (data instanceof Error) throw data;
      return data;
    },
  } as any);

  it('should return the package the store holds', async () => {
    const pkg = Buffer.from('a whole deb');

    assert.deepStrictEqual(await readPackageFromPool(poolStore(pkg.length, pkg), 'key'), pkg);
  });

  it('should return null for a package the store does not have yet', async () => {
    assert.strictEqual(await readPackageFromPool(poolStore(0, Buffer.from('')), 'key'), null);
  });

  // The stores answer a failed read with an empty buffer, so a short read is the only thing
  // separating a broken fetch from a package that really is that size
  it('should reject a read that came back short rather than staging it', async () => {
    await assert.rejects(
      readPackageFromPool(poolStore(4096, Buffer.from('')), 'key'),
      /Read 0 bytes of key from the store, which reported 4096/,
    );
  });

  it('should not swallow a failed size check', async () => {
    const store = { getFileSize: async () => { throw new Error('HEAD failed'); } } as any;

    await assert.rejects(readPackageFromPool(store, 'key'), /HEAD failed/);
  });

  it('should not swallow a failed read', async () => {
    await assert.rejects(readPackageFromPool(poolStore(11, new Error('GET failed')), 'key'), /GET failed/);
  });
});
