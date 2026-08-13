import * as fs from 'fs/promises';
import * as path from 'path';

export const syncDirectoryToStore = async (store: IFileStore, keyPrefix: string, localBaseDir: string, relative: string = '.') => {
  for (const child of await fs.readdir(path.resolve(localBaseDir, relative))) {
    const absoluteChild = path.resolve(localBaseDir, relative, child);
    if ((await fs.stat(absoluteChild)).isDirectory()) {
      await syncDirectoryToStore(store, keyPrefix, localBaseDir, path.join(relative, child));
    } else {
      await store.putFile(
        path.posix.join(keyPrefix, relative, child),
        await fs.readFile(absoluteChild),
        true,
      );
    }
  }
};

/**
 * Uploads only the named files out of a working directory.
 *
 * The linux repo builders stage published packages next to the metadata they generate, because
 * the indexing tools need the packages on disk to read them.  Those packages came from the store
 * and are unchanged, so naming the metadata explicitly is what stops a rebuild from uploading
 * hundreds of megabytes of packages back over themselves.
 */
export const syncFilesToStore = async (store: IFileStore, keyPrefix: string, localBaseDir: string, relativePaths: string[]) => {
  for (const relativePath of relativePaths) {
    await store.putFile(
      path.posix.join(keyPrefix, relativePath),
      await fs.readFile(path.resolve(localBaseDir, relativePath)),
      true,
    );
  }
};
