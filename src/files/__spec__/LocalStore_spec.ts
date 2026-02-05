import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import LocalStore from '../local/LocalStore';

describe('LocalStore', () => {
  let store: LocalStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'localstore-test-'));
    store = new LocalStore({
      root: tmpDir,
      staticUrl: 'http://localhost:9999',
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getPublicBaseUrl', () => {
    it('should return the configured static URL', async () => {
      assert.strictEqual(await store.getPublicBaseUrl(), 'http://localhost:9999');
    });
  });

  describe('hasFile', () => {
    it('should return false for non-existent files', async () => {
      assert.strictEqual(await store.hasFile('nonexistent.txt'), false);
    });

    it('should return true for existing files', async () => {
      await fs.writeFile(path.join(tmpDir, 'test.txt'), 'content');
      assert.strictEqual(await store.hasFile('test.txt'), true);
    });

    it('should return false for directories', async () => {
      await fs.mkdir(path.join(tmpDir, 'testdir'));
      assert.strictEqual(await store.hasFile('testdir'), false);
    });
  });

  describe('getFileSize', () => {
    it('should return 0 for non-existent files', async () => {
      assert.strictEqual(await store.getFileSize('nonexistent.txt'), 0);
    });

    it('should return the file size for existing files', async () => {
      const content = 'Hello, World!';
      await fs.writeFile(path.join(tmpDir, 'test.txt'), content);
      assert.strictEqual(await store.getFileSize('test.txt'), content.length);
    });
  });

  describe('putFile', () => {
    it('should write files to the correct path', async () => {
      const data = Buffer.from('test content');
      const result = await store.putFile('myfile.txt', data);

      assert.strictEqual(result, true);
      const written = await fs.readFile(path.join(tmpDir, 'myfile.txt'));
      assert.deepStrictEqual(written, data);
    });

    it('should create parent directories if they do not exist', async () => {
      const data = Buffer.from('nested content');
      const result = await store.putFile('subdir/nested/file.txt', data);

      assert.strictEqual(result, true);
      const written = await fs.readFile(path.join(tmpDir, 'subdir/nested/file.txt'));
      assert.deepStrictEqual(written, data);
    });

    it('should not overwrite files by default', async () => {
      const originalData = Buffer.from('original');
      const newData = Buffer.from('new');

      await store.putFile('myfile.txt', originalData);
      const result = await store.putFile('myfile.txt', newData);

      assert.strictEqual(result, false);
      const content = await fs.readFile(path.join(tmpDir, 'myfile.txt'));
      assert.deepStrictEqual(content, originalData);
    });

    it('should overwrite files when overwrite = true', async () => {
      const originalData = Buffer.from('original');
      const newData = Buffer.from('new');

      await store.putFile('myfile.txt', originalData);
      const result = await store.putFile('myfile.txt', newData, true);

      assert.strictEqual(result, true);
      const content = await fs.readFile(path.join(tmpDir, 'myfile.txt'));
      assert.deepStrictEqual(content, newData);
    });
  });

  describe('getFile', () => {
    it('should return empty buffer for non-existent files', async () => {
      const result = await store.getFile('nonexistent.txt');
      assert.deepStrictEqual(result, Buffer.from(''));
    });

    it('should return file contents for existing files', async () => {
      const content = Buffer.from('file content');
      await fs.writeFile(path.join(tmpDir, 'test.txt'), content);

      const result = await store.getFile('test.txt');
      assert.deepStrictEqual(result, content);
    });
  });

  describe('listFiles', () => {
    it('should return empty array for non-existent prefix', async () => {
      const files = await store.listFiles('nonexistent');
      assert.deepStrictEqual(files, []);
    });

    it('should return files in a directory', async () => {
      await fs.mkdir(path.join(tmpDir, 'mydir'));
      await fs.writeFile(path.join(tmpDir, 'mydir/file1.txt'), 'content1');
      await fs.writeFile(path.join(tmpDir, 'mydir/file2.txt'), 'content2');

      const files = await store.listFiles('mydir');
      assert.deepStrictEqual(files.sort(), ['mydir/file1.txt', 'mydir/file2.txt']);
    });

    it('should return files recursively', async () => {
      await fs.mkdir(path.join(tmpDir, 'mydir/subdir'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'mydir/file1.txt'), 'content1');
      await fs.writeFile(path.join(tmpDir, 'mydir/subdir/file2.txt'), 'content2');

      const files = await store.listFiles('mydir');
      assert.deepStrictEqual(files.sort(), ['mydir/file1.txt', 'mydir/subdir/file2.txt']);
    });
  });

  describe('deletePath', () => {
    it('should delete a file', async () => {
      await fs.writeFile(path.join(tmpDir, 'todelete.txt'), 'content');
      assert.strictEqual(await store.hasFile('todelete.txt'), true);

      await store.deletePath('todelete.txt');
      assert.strictEqual(await store.hasFile('todelete.txt'), false);
    });

    it('should delete a directory recursively', async () => {
      await fs.mkdir(path.join(tmpDir, 'mydir/subdir'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'mydir/file1.txt'), 'content1');
      await fs.writeFile(path.join(tmpDir, 'mydir/subdir/file2.txt'), 'content2');

      await store.deletePath('mydir');

      const exists = await fs.access(path.join(tmpDir, 'mydir')).then(() => true).catch(() => false);
      assert.strictEqual(exists, false);
    });

    it('should not throw for non-existent paths', async () => {
      await assert.doesNotReject(async () => {
        await store.deletePath('nonexistent');
      });
    });
  });
});
