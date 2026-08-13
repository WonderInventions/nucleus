import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { stub, SinonStub } from 'sinon';

import Positioner from '../Positioner';
import { generateSHAs } from '../utils/sha';

const fakeApp: NucleusApp = {
  id: 'fake_id',
  slug: 'fake_slug',
  name: 'Fake Slug',
} as any;
const fakeApp2: NucleusApp = {
  id: 'fake_id_2',
  slug: 'fake_slug_2',
} as any;
const fakeChannel: NucleusChannel = {
  id: 'fake_channel_id',
  versions: [],
} as any;
const fakeChannel2: NucleusChannel = {
  id: 'fake_channel_id_2',
  versions: [],
} as any;

const promiseStub = () => {
  const s = stub();
  s.returns(Promise.resolve());
  return s;
};

const v1 = {
  currentRelease: '0.0.2',
  releases: [{
    updateTo: {
      name: '0.0.2',
      notes: '',
      pub_date: 'MyDate',
      url: 'https://foo.bar/fake_slug/fake_channel_id/darwin/x64/thing.zip',
      version: '0.0.2',
    },
    version: '0.0.2',
  }],
};

const v2 = Object.assign({}, v1);
v2.releases = Object.assign([], v2.releases);
v2.releases.push({
  updateTo: {
    name: '0.0.3',
    version: '0.0.3',
    notes: '',
    pub_date: 'MyDate',
    url: 'https://foo.bar/fake_slug/fake_channel_id/darwin/x64/thing2.zip',
  },
  version: '0.0.3',
});
v2.currentRelease = '0.0.3';

describe('Positioner', () => {
  let fakeStore: {
    copyFile: SinonStub;
    getFile: SinonStub;
    putFile: SinonStub;
    getPublicBaseUrl: SinonStub;
    deletePath: SinonStub;
    listFiles: SinonStub;
    hasFile: SinonStub;
    getFileSize: SinonStub;
  };
  let positioner: Positioner;
  let originalDateToString: SinonStub;
  let lock: string;

  before(() => {
    process.env.NO_NUCLEUS_INDEX = 'true';
  });

  after(() => {
    delete process.env.NO_NUCLEUS_INDEX;
  });

  beforeEach(async () => {
    fakeStore = {
      copyFile: promiseStub().returns(true),
      getFile: promiseStub().returns(Buffer.from('')),
      getPublicBaseUrl: promiseStub(),
      putFile: promiseStub(),
      deletePath: promiseStub(),
      listFiles: promiseStub().returns([]),
      hasFile: promiseStub().returns(true),
      getFileSize: promiseStub().returns(Promise.resolve(0)),
    };
    fakeStore.putFile.returns(Promise.resolve(true));
    positioner = new Positioner(fakeStore);
    originalDateToString = stub(Date.prototype, 'toString');
    originalDateToString.returns('MyDate');
    lock = (await positioner.requestLock(fakeApp, fakeChannel))!;
    fakeStore.getFile.onSecondCall().returns(Buffer.from(lock));
    fakeStore.putFile.reset();
    fakeStore.putFile.returns(true);
    fakeStore.getPublicBaseUrl.returns('https://foo.bar');
  });

  afterEach(async () => {
    originalDateToString.restore();
    await positioner.releaseLock(fakeApp, fakeChannel, lock);
  });

  it('should not position unknown arches', async () => {
    await positioner.handleUpload(lock, {
      app: fakeApp,
      channel: fakeChannel,
      internalVersion: { name: '0.0.2' } as any,
      file: {
        ...generateSHAs(Buffer.from('')),
        arch: 'magicBit' as any,
        platform: 'win32',
        fileName: 'thing.exe',
        type: 'installer',
      },
      fileData: Buffer.from(''),
    });
    assert.strictEqual(fakeStore.putFile.callCount, 0);
  });

  it('should not position unknown platfroms', async () => {
    await positioner.handleUpload(lock, {
      app: fakeApp,
      channel: fakeChannel,
      internalVersion: { name: '0.0.2' } as any,
      file: {
        ...generateSHAs(Buffer.from('')),
        arch: 'x64',
        platform: 'chromeOS' as any,
        fileName: 'thing.apk',
        type: 'installer',
      },
      fileData: Buffer.from(''),
    });
    assert.strictEqual(fakeStore.putFile.callCount, 0);
  });

  describe('positioning OS files', () => {
    describe('for any OS', () => {
      let handleWindowsUpload: SinonStub;
      let handleDarwinUpload: SinonStub;
      let handleLinuxUpload: SinonStub;

      beforeEach(() => {
        handleWindowsUpload = stub(positioner as any, 'handleWindowsUpload');
        handleDarwinUpload = stub(positioner as any, 'handleDarwinUpload');
        handleLinuxUpload = stub(positioner as any, 'handleLinuxUpload');
      });

      afterEach(() => {
        handleWindowsUpload.restore();
        handleDarwinUpload.restore();
        handleLinuxUpload.restore();
      });

      afterEach(() => {
        // Reset versions to empty array for other tests
        fakeChannel.versions = [];
      });

      describe('for already uploaded releases -- potentiallyUpdateLatestInstallers', () => {
        it('should do nothing if the rollout is not 100%', async () => {
          await positioner.potentiallyUpdateLatestInstallers(lock, fakeApp, Object.assign({}, fakeChannel, { versions: [{ rollout: 50 } as any] }));
          assert.strictEqual(fakeStore.putFile.callCount, 0);
        });

        it('should copy all installers to the latest spot when rollout=100 and latest', async () => {
          await positioner.potentiallyUpdateLatestInstallers(
            lock,
            fakeApp,
            Object.assign({}, fakeChannel, {
              versions: [{
                name: '0.0.2',
                rollout: 100,
                files: [{
                  type: 'installer',
                  fileName: 'test.exe',
                  platform: 'win32',
                  arch: 'x64',
                }, {
                  type: 'update',
                  fileName: 'test.nupkg',
                  platform: 'win32',
                  arch: 'x64',
                }, {
                  type: 'installer',
                  fileName: 'test.dmg',
                  platform: 'darwin',
                  arch: 'x64',
                }],
              } as any],
            }),
          );
          // Asserted as sets rather than in order: these run concurrently
          assert.deepStrictEqual(
            fakeStore.copyFile.getCalls().map(call => call.args).sort(),
            [
              [
                'fake_slug/fake_channel_id/_index/0.0.2/darwin/x64/test.dmg',
                'fake_slug/fake_channel_id/latest/darwin/x64/Fake Slug.dmg',
                true,
              ],
              [
                'fake_slug/fake_channel_id/_index/0.0.2/win32/x64/test.exe',
                'fake_slug/fake_channel_id/latest/win32/x64/Fake Slug.exe',
                true,
              ],
            ].sort(),
          );
          // Only the refs are written; the installers themselves never leave the store
          assert.deepStrictEqual(
            fakeStore.putFile.getCalls().map(call => [call.args[0], call.args[1].toString()]).sort(),
            [
              ['fake_slug/fake_channel_id/latest/darwin/x64/Fake Slug.dmg.ref', '0.0.2'],
              ['fake_slug/fake_channel_id/latest/win32/x64/Fake Slug.exe.ref', '0.0.2'],
            ].sort(),
          );
          assert.strictEqual(
            fakeStore.getFile.getCalls().filter(call => !call.args[0].endsWith('.lock')).length,
            2,
            'should read the two refs and nothing else',
          );
        });

        it('should not publish a latest installer whose indexed file is missing', async () => {
          fakeStore.hasFile.returns(Promise.resolve(false));
          await positioner.potentiallyUpdateLatestInstallers(
            lock,
            fakeApp,
            Object.assign({}, fakeChannel, {
              versions: [{
                name: '0.0.2',
                rollout: 100,
                files: [{
                  type: 'installer',
                  fileName: 'test.dmg',
                  platform: 'darwin',
                  arch: 'x64',
                }],
              } as any],
            }),
          );
          assert.strictEqual(fakeStore.putFile.callCount, 0);
          assert.strictEqual(fakeStore.copyFile.callCount, 0);
        });
      });

      it('should not upload the "Latest" file for any installer type release if it is not the latest release', async () => {
        fakeChannel.versions.push({
          name: '0.0.3',
          rollout: 100,
        } as any);
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2', rollout: 100 } as any,
          file: {
            ...generateSHAs(Buffer.from('')),
            arch: 'ia32',
            platform: 'linux',
            fileName: 'thing.deb',
            type: 'installer',
          },
          fileData: Buffer.from(''),
        });
        assert.strictEqual(fakeStore.putFile.callCount, 0);
      });

      it('should not upload the "Latest" file for any installer type release if it is dead', async () => {
        fakeChannel.versions = [];
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2', rollout: 100, dead: true } as any,
          file: {
            ...generateSHAs(Buffer.from('')),
            arch: 'ia32',
            platform: 'linux',
            fileName: 'thing.deb',
            type: 'installer',
          },
          fileData: Buffer.from(''),
        });
        assert.strictEqual(fakeStore.putFile.callCount, 0);
      });

      it('should not upload the "Latest" file for any installer type release if it is not at 100% rollout', async () => {
        fakeChannel.versions = [];
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2', rollout: 99 } as any,
          file: {
            ...generateSHAs(Buffer.from('')),
            arch: 'ia32',
            platform: 'linux',
            fileName: 'thing.deb',
            type: 'installer',
          },
          fileData: Buffer.from(''),
        });
        assert.strictEqual(fakeStore.putFile.callCount, 0);
      });
    });

    describe('windows', () => {
      it('should not position unknown files in the store', async () => {
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(Buffer.from('')),
            arch: 'ia32',
            platform: 'win32',
            fileName: 'thing.wet',
            type: 'installer',
          },
          fileData: Buffer.from(''),
        });
        assert.strictEqual(fakeStore.putFile.callCount, 0);
      });

      it('should position exe files in arch bucket', async () => {
        const fakeBuffer = Buffer.from('my exe');
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(fakeBuffer),
            arch: 'ia32',
            platform: 'win32',
            fileName: 'thing.exe',
            type: 'installer',
          },
          fileData: fakeBuffer,
        });
        assert.strictEqual(fakeStore.putFile.callCount, 1);
        assert.strictEqual(
          fakeStore.putFile.firstCall.args[0],
          'fake_slug/fake_channel_id/win32/ia32/thing.exe',
        );
        assert.strictEqual(fakeStore.putFile.firstCall.args[1], fakeBuffer);
      });

      it('should position different arches in separate key paths', async () => {
        const firstBuffer = Buffer.from('my exe');
        const secondBuffer = Buffer.from('my other exe');
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(firstBuffer),
            arch: 'ia32',
            platform: 'win32',
            fileName: 'thing.exe',
            type: 'installer',
          },
          fileData: firstBuffer,
        });
        assert.strictEqual(
          fakeStore.putFile.firstCall.args[0],
          'fake_slug/fake_channel_id/win32/ia32/thing.exe',
        );
        assert.strictEqual(fakeStore.putFile.firstCall.args[1], firstBuffer);
        fakeStore.getFile.onCall(2).returns(Buffer.from(lock));
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(secondBuffer),
            arch: 'x64',
            platform: 'win32',
            fileName: 'thing.exe',
            type: 'installer',
          },
          fileData: secondBuffer,
        });
        assert.strictEqual(
          fakeStore.putFile.secondCall.args[0],
          'fake_slug/fake_channel_id/win32/x64/thing.exe',
        );
        assert.strictEqual(fakeStore.putFile.secondCall.args[1], secondBuffer);
      });

      it('should position nupkg files in arch bucket', async () => {
        const fakeBuffer = Buffer.from('my nupkg');
        fakeStore.getFile.returns(Promise.resolve(Buffer.from('')));
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(fakeBuffer),
            arch: 'ia32',
            platform: 'win32',
            fileName: 'thing-full.nupkg',
            type: 'update',
          },
          fileData: fakeBuffer,
        });
        // NUPKG + REF + 101*RELEASES
        assert.strictEqual(fakeStore.putFile.callCount, 2 + 101);
        assert.strictEqual(
          fakeStore.putFile.firstCall.args[0],
          'fake_slug/fake_channel_id/win32/ia32/thing-full.nupkg',
        );
        assert.strictEqual(fakeStore.putFile.firstCall.args[1], fakeBuffer);
        assert.ok(!fakeStore.putFile.firstCall.args[2], 'should not override existing release');
      });

      it('should update the RELEASES file with correct hash and filename for all nupkg uploads', async () => {
        const fakeBuffer = Buffer.from('my nupkg');
        fakeStore.getFileSize.onFirstCall().returns(8);
        const fullFile = {
          ...generateSHAs(fakeBuffer),
          arch: 'ia32',
          platform: 'win32',
          fileName: 'thing-full.nupkg',
          type: 'update',
        } as any;
        const fakeVersion = { name: '0.0.2', rollout: 0, files: [fullFile] } as any;
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: Object.assign({}, fakeChannel, {
            versions: [fakeVersion],
          }),
          internalVersion: fakeVersion,
          file: fullFile,
          fileData: fakeBuffer,
        });
        // NUPKG + REF + 101*RELEASES
        assert.strictEqual(fakeStore.putFile.callCount, 2 + 101);
        assert.strictEqual(
          fakeStore.putFile.secondCall.args[0],
          'fake_slug/fake_channel_id/win32/ia32/RELEASES',
        );
        assert.strictEqual(
          fakeStore.putFile.secondCall.args[1].toString(),
          '0F2320FC3B29E1CD9F989DBF547BCD4D21D3BD12 https://foo.bar/fake_slug/fake_channel_id/win32/ia32/thing-full.nupkg 8',
        );
        assert.strictEqual(fakeStore.putFile.secondCall.args[2], true, 'should override existing RELEASES');
      });

      it('should append to the existing RELEASES file if available', async () => {
        const fakeFullBuffer = Buffer.from('my nupkg');
        const fakeDeltaBuffer = Buffer.from('my delta nupkg');
        fakeStore.getFile.returns(Promise.resolve(Buffer.from('0F2320FC3B29E1CD9F989DBF547BCD4D21D3BD12 thing-full.nupkg 8')));
        const fullFile = {
          ...generateSHAs(fakeFullBuffer),
          arch: 'ia32',
          platform: 'win32',
          fileName: 'thing-full.nupkg',
          type: 'update',
        } as any;
        const deltaFile = {
          ...generateSHAs(fakeDeltaBuffer),
          arch: 'ia32',
          platform: 'win32',
          fileName: 'thing-delta.nupkg',
          type: 'update',
        } as any;
        fakeStore.getFileSize.onFirstCall().returns(8);
        fakeStore.getFileSize.onSecondCall().returns(14);
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: Object.assign({}, fakeChannel, {
            versions: [{
              name: '0.0.2',
              rollout: 100,
              files: [fullFile, deltaFile],
            }],
          }),
          internalVersion: { name: '0.0.2' } as any,
          file: deltaFile,
          fileData: fakeDeltaBuffer,
        });
        // NUPKG + REF + 101*RELEASES
        assert.strictEqual(fakeStore.putFile.callCount, 2 + 101);
        assert.strictEqual(
          fakeStore.putFile.secondCall.args[0],
          'fake_slug/fake_channel_id/win32/ia32/RELEASES',
        );
        assert.strictEqual(
          fakeStore.putFile.secondCall.args[1].toString(),
          '0F2320FC3B29E1CD9F989DBF547BCD4D21D3BD12 https://foo.bar/fake_slug/fake_channel_id/win32/ia32/thing-full.nupkg 8\n' +
          'EF5518DDAF73D40E2A7A31C627702CFFBF59862D https://foo.bar/fake_slug/fake_channel_id/win32/ia32/thing-delta.nupkg 14',
        );
      });

      it('should not update the RELEASES file if the nupkg is already in the bucket', async () => {
        const fakeBuffer = Buffer.from('my delta nupkg');
        fakeStore.putFile.returns(Promise.resolve(false));
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(fakeBuffer),
            arch: 'ia32',
            platform: 'win32',
            fileName: 'thing-delta.nupkg',
            type: 'update',
          },
          fileData: fakeBuffer,
        });
        assert.strictEqual(fakeStore.putFile.callCount, 1);
      });
    });

    describe('darwin', () => {
      it('should not position unknown files in the store', async () => {
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(Buffer.from('')),
            arch: 'x64',
            platform: 'darwin',
            fileName: 'thing.exe',
            type: 'installer',
          },
          fileData: Buffer.from(''),
        });
        await positioner.handleUpload(lock,{
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(Buffer.from('')),
            arch: 'x64',
            platform: 'darwin',
            fileName: 'thing.lel',
            type: 'installer',
          },
          fileData: Buffer.from(''),
        });
        assert.strictEqual(fakeStore.putFile.callCount, 0);
      });

      it('should position dmg files in arch bucket', async () => {
        const fakeBuffer = Buffer.from('my dmg');
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(fakeBuffer),
            arch: 'x64',
            platform: 'darwin',
            fileName: 'thing.dmg',
            type: 'installer',
          },
          fileData: fakeBuffer,
        });
        assert.strictEqual(fakeStore.putFile.callCount, 1);
        assert.strictEqual(
          fakeStore.putFile.firstCall.args[0],
          'fake_slug/fake_channel_id/darwin/x64/thing.dmg',
        );
        assert.strictEqual(fakeStore.putFile.firstCall.args[1], fakeBuffer);
      });

      it('should position zip files in arch bucket', async () => {
        const fakeBuffer = Buffer.from('my zip');
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(fakeBuffer),
            arch: 'x64',
            platform: 'darwin',
            fileName: 'thing.zip',
            type: 'installer',
          },
          fileData: fakeBuffer,
        });
        // ZIP + REF + 101*RELEASES
        assert.strictEqual(fakeStore.putFile.callCount, 2 + 101);
        assert.strictEqual(
          fakeStore.putFile.firstCall.args[0],
          'fake_slug/fake_channel_id/darwin/x64/thing.zip',
        );
        assert.strictEqual(fakeStore.putFile.firstCall.args[1], fakeBuffer);
      });

      it('should create a RELEASES.json file if it doesn\'t exist when uploading zips', async () => {
        const fakeBuffer = Buffer.from('my zip');
        const file: NucleusFile = {
          ...generateSHAs(fakeBuffer),
          arch: 'x64',
          platform: 'darwin',
          fileName: 'thing.zip',
          type: 'installer',
        };
        fakeChannel.versions.push({
          name: '0.0.2',
          rollout: 0,
          files: [file],
        } as any);
        await positioner.handleUpload(lock, {
          file,
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          fileData: fakeBuffer,
        });
        // ZIP + REF + 101*RELEASES
        assert.strictEqual(fakeStore.putFile.callCount, 2 + 101);
        assert.strictEqual(
          fakeStore.putFile.secondCall.args[0],
          'fake_slug/fake_channel_id/darwin/x64/RELEASES.json',
        );
        assert.deepStrictEqual(JSON.parse(fakeStore.putFile.secondCall.args[1].toString()), v1);
      });

      it('should update the RELEASES.json file if it already exits when uploading zips', async () => {
        const fakeBuffer = Buffer.from('my zip');
        const file1: NucleusFile = {
          ...generateSHAs(fakeBuffer),
          arch: 'x64',
          platform: 'darwin',
          fileName: 'thing2.zip',
          type: 'installer',
        };
        fakeChannel.versions.push({
          name: '0.0.3',
          rollout: 0,
          files: [file1],
        } as any);
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.3' } as any,
          file: file1,
          fileData: fakeBuffer,
        });
        // ZIP + REF + 101*RELEASES
        assert.strictEqual(fakeStore.putFile.callCount, 2 + 101);
        assert.strictEqual(
          fakeStore.putFile.secondCall.args[0],
          'fake_slug/fake_channel_id/darwin/x64/RELEASES.json',
        );
        assert.deepStrictEqual(JSON.parse(fakeStore.putFile.secondCall.args[1].toString()), v2);
      });

      it('should update the RELEASES.json file even if the version is already in the releases array but not use the new file', async () => {
        const fakeBuffer = Buffer.from('my zip');
        const file: NucleusFile = {
          ...generateSHAs(fakeBuffer),
          arch: 'x64',
          platform: 'darwin',
          fileName: 'thing3.zip',
          type: 'installer',
        };
        fakeChannel.versions[0].files.push(file);
        await positioner.handleUpload(lock, {
          file,
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          fileData: fakeBuffer,
        });
        // ZIP + REF + 101*RELEASES
        assert.strictEqual(fakeStore.putFile.callCount, 2 + 101);
        assert.deepStrictEqual(JSON.parse(fakeStore.putFile.secondCall.args[1].toString()), v2);
      });

      it('should not update the "currentRelease" property in the RELEASES.json file if it is higher than the new release', async () => {
        const fakeBuffer = Buffer.from('my zip');
        const file: NucleusFile = {
          ...generateSHAs(fakeBuffer),
          arch: 'x64',
          platform: 'darwin',
          fileName: 'thing2.zip',
          type: 'installer',
        };
        // Replace 0.0.3
        fakeChannel.versions[1] = {
          name: '0.0.1',
          rollout: 0,
          files: [file],
        } as any;
        await positioner.handleUpload(lock, {
          file,
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.1' } as any,
          fileData: fakeBuffer,
        });
        // ZIP + REF + 101*RELEASES
        assert.strictEqual(fakeStore.putFile.callCount, 2 + 101);
        assert.strictEqual(
          fakeStore.putFile.secondCall.args[0],
          'fake_slug/fake_channel_id/darwin/x64/RELEASES.json',
        );
        const expected = Object.assign({}, v1);
        expected.releases = Object.assign([], expected.releases);
        expected.releases.push({
          updateTo: {
            name: '0.0.1',
            version: '0.0.1',
            notes: '',
            pub_date: 'MyDate',
            url: 'https://foo.bar/fake_slug/fake_channel_id/darwin/x64/thing2.zip',
          },
          version: '0.0.1',
        });
        assert.deepStrictEqual(JSON.parse(fakeStore.putFile.secondCall.args[1].toString()), expected);
      });

      it('should not update the RELEASES.json file if the zip already existed on the bucket', async () => {
        const fakeBuffer = Buffer.from('my zip');
        fakeStore.putFile.returns(Promise.resolve(false));
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(fakeBuffer),
            arch: 'x64',
            platform: 'darwin',
            fileName: 'thing2.zip',
            type: 'installer',
          },
          fileData: fakeBuffer,
        });
        assert.strictEqual(fakeStore.putFile.callCount, 1);
      });
    });

    describe('linux', () => {
      // FIXME(MarshallOfSound): Test the linuxHelpers and remove this test
      it.skip('should not position any files in the store', async () => {
        await positioner.handleUpload(lock, {
          app: fakeApp,
          channel: fakeChannel,
          internalVersion: { name: '0.0.2' } as any,
          file: {
            ...generateSHAs(Buffer.from('')),
            arch: 'ia32',
            platform: 'linux',
            fileName: 'thing.dev',
            type: 'installer',
          },
          fileData: Buffer.from(''),
        });
        assert.strictEqual(fakeStore.putFile.callCount, 0);
      });
    });
  });

  describe('cleanUpDeletedVersionFiles', () => {
    const deletedVersion: NucleusVersion = {
      name: '0.0.2',
      dead: true,
      rollout: 100,
      files: [
        { ...generateSHAs(Buffer.from('')), fileName: 'thing.exe', arch: 'x64', platform: 'win32', type: 'installer' },
        { ...generateSHAs(Buffer.from('')), fileName: 'thing.dmg', arch: 'arm64', platform: 'darwin', type: 'installer' },
        { ...generateSHAs(Buffer.from('')), fileName: 'thing.deb', arch: 'x64', platform: 'linux', type: 'installer' },
        { ...generateSHAs(Buffer.from('')), fileName: 'thing.rpm', arch: 'x64', platform: 'linux', type: 'installer' },
      ],
    };

    let regenerateAptRepo: SinonStub;
    let regenerateYumRepo: SinonStub;

    beforeEach(() => {
      regenerateAptRepo = promiseStub();
      regenerateYumRepo = promiseStub();
      positioner.regenerateAptRepo = regenerateAptRepo;
      positioner.regenerateYumRepo = regenerateYumRepo;
    });

    it('should regenerate the linux repo metadata when linux packages were deleted', async () => {
      await positioner.cleanUpDeletedVersionFiles(lock, fakeApp, fakeChannel, [deletedVersion]);
      assert.strictEqual(regenerateAptRepo.callCount, 1);
      assert.strictEqual(regenerateYumRepo.callCount, 1);
      assert.ok(regenerateAptRepo.calledWith(fakeApp, fakeChannel));
      assert.ok(regenerateYumRepo.calledWith(fakeApp, fakeChannel));
    });

    it('should not regenerate the linux repo metadata when no linux packages were deleted', async () => {
      const darwinOnlyVersion: NucleusVersion = {
        name: '0.0.2',
        dead: true,
        rollout: 100,
        files: [
          { ...generateSHAs(Buffer.from('')), fileName: 'thing.dmg', arch: 'arm64', platform: 'darwin', type: 'installer' },
        ],
      };
      await positioner.cleanUpDeletedVersionFiles(lock, fakeApp, fakeChannel, [darwinOnlyVersion]);
      assert.strictEqual(regenerateAptRepo.callCount, 0);
      assert.strictEqual(regenerateYumRepo.callCount, 0);
    });

    it('should delete the _index tree for each deleted version', async () => {
      await positioner.cleanUpDeletedVersionFiles(lock, fakeApp, fakeChannel, [deletedVersion]);
      assert.ok(fakeStore.deletePath.calledWith('fake_slug/fake_channel_id/_index/0.0.2'));
    });

    it('should delete win32 and darwin platform artifacts', async () => {
      await positioner.cleanUpDeletedVersionFiles(lock, fakeApp, fakeChannel, [deletedVersion]);
      assert.ok(fakeStore.deletePath.calledWith('fake_slug/fake_channel_id/win32/x64/thing.exe'));
      assert.ok(fakeStore.deletePath.calledWith('fake_slug/fake_channel_id/darwin/arm64/thing.dmg'));
    });

    it('should delete linux apt and yum package files', async () => {
      await positioner.cleanUpDeletedVersionFiles(lock, fakeApp, fakeChannel, [deletedVersion]);
      assert.ok(fakeStore.deletePath.calledWith('fake_slug/fake_channel_id/linux/debian/binary/0.0.2-thing.deb'));
      assert.ok(fakeStore.deletePath.calledWith('fake_slug/fake_channel_id/linux/redhat/0.0.2-thing.rpm'));
    });

    it('should delete exactly one path per file plus the _index tree', async () => {
      await positioner.cleanUpDeletedVersionFiles(lock, fakeApp, fakeChannel, [deletedVersion]);
      assert.strictEqual(fakeStore.deletePath.callCount, 5);
    });

    it('should delete nothing without a valid lock', async () => {
      assert.strictEqual(
        await positioner.cleanUpDeletedVersionFiles('not-the-lock', fakeApp, fakeChannel, [deletedVersion]),
        false,
      );
      assert.strictEqual(fakeStore.deletePath.callCount, 0);
      assert.strictEqual(regenerateAptRepo.callCount, 0);
      assert.strictEqual(regenerateYumRepo.callCount, 0);
    });
  });

  // The rest of this file runs with NO_NUCLEUS_INDEX set, which takes the fallback that uploads the
  // bytes a second time.  Publishing a release goes the other way: the index copy is the source
  describe('publishing from the index', () => {
    const position = async (fileName: string, platform: NucleusPlatform, arch = 'x64') => {
      await positioner.handleUpload(lock, {
        app: fakeApp,
        channel: fakeChannel,
        internalVersion: { name: '0.0.2', rollout: 100 } as any,
        file: { ...generateSHAs(Buffer.from('')), arch, platform, fileName, type: 'installer' },
        fileData: Buffer.from('the installer'),
      });
    };

    beforeEach(() => {
      delete process.env.NO_NUCLEUS_INDEX;
      fakeStore.getFile.callsFake(async (key: string) =>
        key.endsWith('.lock') ? Buffer.from(lock) : Buffer.from(''));
    });

    afterEach(() => {
      process.env.NO_NUCLEUS_INDEX = 'true';
    });

    it('should copy a darwin artifact into place rather than uploading it again', async () => {
      await position('thing.dmg', 'darwin');

      assert.deepStrictEqual(fakeStore.copyFile.getCalls().map(call => call.args), [[
        'fake_slug/fake_channel_id/_index/0.0.2/darwin/x64/thing.dmg',
        'fake_slug/fake_channel_id/darwin/x64/thing.dmg',
        false,
      ]]);
      assert.deepStrictEqual(
        fakeStore.putFile.getCalls().map(call => call.args[0]),
        ['fake_slug/fake_channel_id/_index/0.0.2/darwin/x64/thing.dmg'],
      );
    });

    it('should copy a win32 artifact into place rather than uploading it again', async () => {
      await position('thing.exe', 'win32');

      assert.deepStrictEqual(fakeStore.copyFile.getCalls().map(call => call.args), [[
        'fake_slug/fake_channel_id/_index/0.0.2/win32/x64/thing.exe',
        'fake_slug/fake_channel_id/win32/x64/thing.exe',
        false,
      ]]);
    });

    // The pool holds the same bytes as the index for debs, unlike rpms, which signing rewrites
    it('should copy a deb into the apt pool, overwriting what is there', async () => {
      await position('thing.deb', 'linux');

      assert.deepStrictEqual(fakeStore.copyFile.getCalls().map(call => call.args), [[
        'fake_slug/fake_channel_id/_index/0.0.2/linux/x64/thing.deb',
        'fake_slug/fake_channel_id/linux/debian/binary/0.0.2-thing.deb',
        true,
      ]]);
    });

    it('should rewrite RELEASES only when the copy actually published something', async () => {
      fakeStore.copyFile.returns(Promise.resolve(false));

      await position('thing-full.nupkg', 'win32');

      assert.strictEqual(fakeStore.copyFile.callCount, 1);
      assert.strictEqual(
        fakeStore.putFile.getCalls().filter(call => call.args[0].endsWith('RELEASES')).length,
        0,
      );
    });

    it('should rewrite RELEASES when the copy published a nupkg', async () => {
      await position('thing-full.nupkg', 'win32');

      assert.ok(
        fakeStore.putFile.getCalls().filter(call => call.args[0].endsWith('RELEASES')).length > 0,
      );
    });
  });

  describe('regenerateLinuxRepos', () => {
    let regenerateAptRepo: SinonStub;
    let regenerateYumRepo: SinonStub;
    let consoleError: SinonStub;

    const position = async (fileName: string) => {
      await positioner.handleUpload(lock, {
        app: fakeApp,
        channel: fakeChannel,
        internalVersion: { name: '0.0.2', rollout: 100 } as any,
        file: { ...generateSHAs(Buffer.from('')), arch: 'x64', platform: 'linux', fileName, type: 'installer' },
        fileData: Buffer.from(''),
      });
    };

    beforeEach(() => {
      regenerateAptRepo = promiseStub();
      regenerateYumRepo = promiseStub();
      positioner.regenerateAptRepo = regenerateAptRepo;
      positioner.regenerateYumRepo = regenerateYumRepo;
      consoleError = stub(console, 'error');
      // Every step here re-reads the lock, so hold it for the whole test rather than one call
      fakeStore.getFile.callsFake(async (key: string) =>
        key.endsWith('.lock') ? Buffer.from(lock) : Buffer.from(''));
      fakeStore.getFile.resetHistory();
    });

    afterEach(() => {
      consoleError.restore();
    });

    it('should rebuild only the repo whose packages were positioned', async () => {
      await position('thing.deb');

      await positioner.regenerateLinuxRepos(lock, fakeApp, fakeChannel);

      assert.strictEqual(regenerateAptRepo.callCount, 1);
      assert.ok(regenerateAptRepo.calledWith(fakeApp, fakeChannel));
      assert.strictEqual(regenerateYumRepo.callCount, 0);
    });

    // Positioning an rpm signs it, which needs a real gpg key and rpmsign, so the yum half is
    // driven through the state that step leaves behind rather than through the step itself
    it('should rebuild both repos when a release positioned debs and rpms', async () => {
      await position('thing.deb');
      (positioner as any).pendingLinuxRepos.yum = true;

      await positioner.regenerateLinuxRepos(lock, fakeApp, fakeChannel);

      assert.strictEqual(regenerateAptRepo.callCount, 1);
      assert.strictEqual(regenerateYumRepo.callCount, 1);
    });

    it('should do nothing for a release that positioned no linux packages', async () => {
      await positioner.regenerateLinuxRepos(lock, fakeApp, fakeChannel);

      assert.strictEqual(regenerateAptRepo.callCount, 0);
      assert.strictEqual(regenerateYumRepo.callCount, 0);
      // Not even the lock read: every darwin and win32 release goes through here too
      assert.strictEqual(fakeStore.getFile.callCount, 0);
    });

    it('should not rebuild the same packages twice', async () => {
      await position('thing.deb');

      await positioner.regenerateLinuxRepos(lock, fakeApp, fakeChannel);
      await positioner.regenerateLinuxRepos(lock, fakeApp, fakeChannel);

      assert.strictEqual(regenerateAptRepo.callCount, 1);
    });

    it('should publish nothing without a valid lock', async () => {
      await position('thing.deb');

      await positioner.regenerateLinuxRepos('not-the-lock', fakeApp, fakeChannel);

      assert.strictEqual(regenerateAptRepo.callCount, 0);
      assert.strictEqual(regenerateYumRepo.callCount, 0);
    });

    it('should report a release that positioned packages and never published them', async () => {
      await position('thing.deb');

      await positioner.releaseLock(fakeApp, fakeChannel, lock);

      assert.strictEqual(consoleError.callCount, 1);
      const reported = JSON.parse(consoleError.getCall(0).args[0]);
      assert.strictEqual(reported.message, 'Released the channel lock with linux packages that were never advertised');
      assert.deepStrictEqual({ apt: reported.apt, yum: reported.yum }, { apt: true, yum: false });
    });

    it('should report a release whose rebuild failed', async () => {
      regenerateAptRepo.rejects(new Error('dpkg-scanpackages exploded'));
      await position('thing.deb');

      await assert.rejects(positioner.regenerateLinuxRepos(lock, fakeApp, fakeChannel));
      await positioner.releaseLock(fakeApp, fakeChannel, lock);

      assert.strictEqual(consoleError.callCount, 1);
    });

    it('should say nothing when the packages were published before the lock went', async () => {
      await position('thing.deb');

      await positioner.regenerateLinuxRepos(lock, fakeApp, fakeChannel);
      await positioner.releaseLock(fakeApp, fakeChannel, lock);

      assert.strictEqual(consoleError.callCount, 0);
    });
  });

  describe('locking', () => {
    beforeEach(() => {
      const files: {
        [key: string]: Buffer;
      } = {};
      Object.assign(fakeStore, {
        getFile: async (key: string) => {
          return files[key] || Buffer.from('');
        },
        putFile: async (key: string, data: Buffer, overwriteExisting?: boolean) => {
          if (!files[key] || overwriteExisting) {
            files[key] = data;
          }
        },
        deletePath: async (key: string) => {
          delete files[key];
        },
      });
    });

    it('should obtain the lock when nothing has claimed it', async () => {
      assert.notStrictEqual(await positioner.requestLock(fakeApp, fakeChannel), null);
    });

    it('should obtain two locks for different apps simultaneously', async () => {
      assert.notStrictEqual(await positioner.requestLock(fakeApp, fakeChannel), null);
      assert.notStrictEqual(await positioner.requestLock(fakeApp2, fakeChannel), null);
    });

    it('should obtain two locks for different channels of the same app simultaneously', async () => {
      assert.notStrictEqual(await positioner.requestLock(fakeApp, fakeChannel), null);
      assert.notStrictEqual(await positioner.requestLock(fakeApp, fakeChannel2), null);
    });

    it('should not issue two locks for the same channel simultaneously', async () => {
      assert.notStrictEqual(await positioner.requestLock(fakeApp, fakeChannel), null);
      assert.strictEqual(await positioner.requestLock(fakeApp, fakeChannel), null);
    });

    it('should issue two locks for the same channel sequentially', async () => {
      const lock = (await positioner.requestLock(fakeApp, fakeChannel))!;
      assert.notStrictEqual(lock, null);
      await positioner.releaseLock(fakeApp, fakeChannel, lock);
      const secondLock = await positioner.requestLock(fakeApp, fakeChannel);
      assert.notStrictEqual(secondLock, null);
      assert.notStrictEqual(lock, secondLock, 'locks should be unique');
    });

    it('should not release a lock if the existing lock is not provided', async () => {
      const lock = (await positioner.requestLock(fakeApp, fakeChannel))!;
      await positioner.releaseLock(fakeApp, fakeChannel, 'this-is-not-the-lock');
      assert.strictEqual(await positioner.requestLock(fakeApp, fakeChannel), null);
      await positioner.releaseLock(fakeApp, fakeChannel, lock);
      assert.notStrictEqual(await positioner.requestLock(fakeApp, fakeChannel), null);
    });

    it('should not release a lock held on a different channel', async () => {
      const lock = (await positioner.requestLock(fakeApp, fakeChannel))!;
      await positioner.releaseLock(fakeApp, fakeChannel2, lock);
      assert.strictEqual(await positioner.requestLock(fakeApp, fakeChannel), null);
    });
  });
});
