import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import LocalStore from '../../local/LocalStore';
import { syncDirectoryToStore, syncFilesToStore } from '../sync';

describe('sync', () => {
  let store: LocalStore;
  let storeRoot: string;
  let workDir: string;

  const write = async (relativePath: string, contents: string) => {
    const absolute = path.resolve(workDir, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, contents);
  };

  const storedKeys = async () => (await store.listFiles('repo')).sort();

  beforeEach(async () => {
    storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-store-'));
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-work-'));
    store = new LocalStore({ root: storeRoot, staticUrl: 'http://localhost:9999' });
  });

  afterEach(async () => {
    await fs.rm(storeRoot, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  });

  describe('syncDirectoryToStore', () => {
    it('should upload the whole tree under the prefix', async () => {
      await write('top.txt', 'top');
      await write('nested/deep.txt', 'deep');

      await syncDirectoryToStore(store, 'repo', workDir);

      assert.deepStrictEqual(await storedKeys(), ['repo/nested/deep.txt', 'repo/top.txt']);
      assert.strictEqual((await store.getFile('repo/nested/deep.txt')).toString(), 'deep');
    });

    // The yum builder leans on this to publish repodata while leaving the packages beside it alone
    it('should upload only the named subdirectory, keyed under it', async () => {
      await write('package.rpm', 'a package');
      await write('repodata/repomd.xml', 'metadata');

      await syncDirectoryToStore(store, 'repo', workDir, 'repodata');

      assert.deepStrictEqual(await storedKeys(), ['repo/repodata/repomd.xml']);
    });
  });

  describe('syncFilesToStore', () => {
    it('should upload only the named files', async () => {
      await write('binary/package.deb', 'a package');
      await write('binary/Packages', 'index');
      await write('binary/Release', 'release');

      await syncFilesToStore(store, 'repo', workDir, ['binary/Packages', 'binary/Release']);

      assert.deepStrictEqual(await storedKeys(), ['repo/binary/Packages', 'repo/binary/Release']);
      assert.strictEqual((await store.getFile('repo/binary/Packages')).toString(), 'index');
    });

    it('should overwrite a key that already exists', async () => {
      await store.putFile('repo/binary/Packages', Buffer.from('stale'), true);
      await write('binary/Packages', 'fresh');

      await syncFilesToStore(store, 'repo', workDir, ['binary/Packages']);

      assert.strictEqual((await store.getFile('repo/binary/Packages')).toString(), 'fresh');
    });

    it('should reject rather than silently skip a file it was told to upload', async () => {
      await write('binary/Packages', 'index');

      await assert.rejects(
        syncFilesToStore(store, 'repo', workDir, ['binary/Packages', 'binary/InRelease']),
        /ENOENT/,
      );
    });
  });
});
