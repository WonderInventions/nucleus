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
    store = new DualWriteStore(primary, secondary, { mirrorRetryDelayMs: 1 });
  });

  describe('putFile', () => {
    it('should mirror the write to the secondary with overwrite enabled when the primary wrote', async () => {
      const data = Buffer.from('value');
      assert.strictEqual(await store.putFile('myKey', data, false), true);

      assert.ok(primary.putFile.calledOnceWith('myKey', data, false));
      assert.ok(secondary.putFile.calledOnceWith('myKey', data, true));
    });

    it('should not write the secondary when the primary skipped and the secondary already has the key', async () => {
      primary.putFile.resolves(false);
      secondary.hasFile.resolves(true);

      assert.strictEqual(await store.putFile('myKey', Buffer.from('value')), false);

      assert.strictEqual(secondary.putFile.callCount, 0);
    });

    it('should heal the secondary with the primary content when the primary skipped and the secondary is missing the key', async () => {
      primary.putFile.resolves(false);
      secondary.hasFile.resolves(false);
      primary.getFile.resolves(Buffer.from('authoritative-content'));

      assert.strictEqual(await store.putFile('myKey', Buffer.from('new-upload-content')), false);

      assert.strictEqual(secondary.putFile.callCount, 1);
      assert.strictEqual(secondary.putFile.firstCall.args[0], 'myKey');
      assert.strictEqual(secondary.putFile.firstCall.args[1].toString(), 'authoritative-content');
      assert.strictEqual(secondary.putFile.firstCall.args[2], true);
    });

    it('should not heal the secondary when the primary content cannot be read', async () => {
      primary.putFile.resolves(false);
      secondary.hasFile.resolves(false);
      primary.getFile.resolves(Buffer.from(''));

      assert.strictEqual(await store.putFile('myKey', Buffer.from('value')), false);

      assert.strictEqual(secondary.putFile.callCount, 0);
    });

    it('should propagate primary write failures without touching the secondary', async () => {
      primary.putFile.rejects(new Error('primary down'));

      await assert.rejects(store.putFile('myKey', Buffer.from('value')), /primary down/);
      assert.strictEqual(secondary.putFile.callCount, 0);
    });

    it('should retry a failed mirror write and succeed', async () => {
      secondary.putFile.onFirstCall().rejects(new Error('secondary blip'));
      secondary.putFile.onSecondCall().resolves(true);

      assert.strictEqual(await store.putFile('myKey', Buffer.from('value'), true), true);

      assert.strictEqual(secondary.putFile.callCount, 2);
    });

    it('should not fail the write when the secondary keeps failing', async () => {
      secondary.putFile.rejects(new Error('secondary down'));

      assert.strictEqual(await store.putFile('myKey', Buffer.from('value'), true), true);

      assert.strictEqual(secondary.putFile.callCount, 3);
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
