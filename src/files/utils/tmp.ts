import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

export const withTmpDir = async <T>(fn: (tmpDir: string) => Promise<T>) => {
  let createdDir = '';
  if (process.platform === 'darwin') {
    await fs.mkdir(path.resolve('/tmp', 'nucleus'), { recursive: true });
    createdDir = await fs.mkdtemp(path.resolve('/tmp', 'nucleus', 'wd-'));
  } else {
    createdDir = await fs.mkdtemp(path.resolve(os.tmpdir(), 'nucleus-wd-'));
  }
  const cleanup = async () => {
    if (await pathExists(createdDir)) {
      await fs.rm(createdDir, { recursive: true, force: true });
    }
  };
  let result: T;
  try {
    result = await fn(createdDir);
  } catch (err) {
    await cleanup();
    throw err;
  }
  await cleanup();
  return result;
};
