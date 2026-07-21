import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { stub, SinonStub } from 'sinon';

import DualWriteStore from '../DualWriteStore';

type FakeStore = { [K in keyof IFileStore]: SinonStub };

const makeFakeStore = (): FakeStore => ({
  putFile: stub().resolves(true),
  hasFile: stub().resolves(true),
  getFile: stub().resolves(Buffer.from('primary-content')),
  getFileSize: stub().resolves(123),
  getPublicBaseUrl: stub().resolves('https://primary.example.com'),
  deletePath: stub().resolves(),
  listFiles: stub().resolves(['a.txt', 'b.txt']),
});

describe('DualWriteStore', () => {
  let primary: FakeStore;
  let secondary: FakeStore;
  let store: DualWriteStore;

  beforeEach(() => {
    primary = makeFakeStore();
    secondary = makeFakeStore();
    store = new DualWriteStore(primary, secondary);
  });

  describe('putFile', () => {
    it('should mirror the write to the secondary with overwrite enabled when the primary wrote', async () => {
      const data = Buffer.from('value');
      assert.strictEqual(await store.putFile('myKey', data, false), true);

      assert.ok(primary.putFile.calledOnceWith('myKey', data, false));
      assert.ok(secondary.putFile.calledOnceWith('myKey', data, true));
    });

    it('should not touch the secondary when the primary skipped the write', async () => {
      primary.putFile.resolves(false);

      assert.strictEqual(await store.putFile('myKey', Buffer.from('value')), false);

      assert.strictEqual(secondary.putFile.callCount, 0);
    });

    it('should propagate primary write failures without touching the secondary', async () => {
      primary.putFile.rejects(new Error('primary down'));

      await assert.rejects(store.putFile('myKey', Buffer.from('value')), /primary down/);
      assert.strictEqual(secondary.putFile.callCount, 0);
    });

    it('should propagate secondary write failures', async () => {
      secondary.putFile.rejects(new Error('secondary down'));

      await assert.rejects(store.putFile('myKey', Buffer.from('value'), true), /secondary down/);
    });
  });

  describe('deletePath', () => {
    it('should delete from both stores', async () => {
      await store.deletePath('some/path');

      assert.ok(primary.deletePath.calledOnceWith('some/path'));
      assert.ok(secondary.deletePath.calledOnceWith('some/path'));
    });

    it('should propagate secondary delete failures', async () => {
      secondary.deletePath.rejects(new Error('secondary down'));

      await assert.rejects(store.deletePath('some/path'), /secondary down/);
    });
  });

  describe('reads', () => {
    it('should serve every read from the primary and never touch the secondary', async () => {
      assert.strictEqual(await store.hasFile('myKey'), true);
      assert.strictEqual((await store.getFile('myKey')).toString(), 'primary-content');
      assert.strictEqual(await store.getFileSize('myKey'), 123);
      assert.strictEqual(await store.getPublicBaseUrl(), 'https://primary.example.com');
      assert.deepStrictEqual(await store.listFiles('prefix'), ['a.txt', 'b.txt']);

      assert.strictEqual(secondary.hasFile.callCount, 0);
      assert.strictEqual(secondary.getFile.callCount, 0);
      assert.strictEqual(secondary.getFileSize.callCount, 0);
      assert.strictEqual(secondary.getPublicBaseUrl.callCount, 0);
      assert.strictEqual(secondary.listFiles.callCount, 0);
    });
  });
});
