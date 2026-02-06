import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';

import { withTmpDir } from '../tmp';

describe('withTmpDir', () => {
  it('should create an empty directory', async () => {
    await withTmpDir(async (tmpDir: string) => {
      assert.notStrictEqual(tmpDir, null);
      assert.strictEqual(typeof tmpDir, 'string');
      assert.strictEqual(await fs.pathExists(tmpDir), true);
      assert.strictEqual((await fs.readdir(tmpDir)).length, 0);
    });
  });

  it('should delete the directory after the async fn resolves', async () => {
    let tmp: string;
    await withTmpDir(async (tmpDir: string) => {
      tmp = tmpDir;
      await fs.writeFile(path.resolve(tmpDir, 'foo'), 'bar');
    });
    assert.strictEqual(await fs.pathExists(tmp!), false);
  });

  it('should delete the directory after the async fn rejects', async () => {
    let tmp: string;
    let threw = false;
    try {
      await withTmpDir(async (tmpDir: string) => {
        tmp = tmpDir;
        throw 'foo';
      });
    } catch (err) {
      assert.strictEqual(err, 'foo');
      threw = true;
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(await fs.pathExists(tmp!), false);
  });

  it('should return the value returned from the inner async fn', async () => {
    const returnValue = await withTmpDir(async () => {
      return 1;
    });
    assert.strictEqual(returnValue, 1);
  });

  it('should not throw if the tmp dir is cleaned up internally', async () => {
    await withTmpDir(async (tmpDir) => {
      await fs.remove(tmpDir);
    });
  });
});
