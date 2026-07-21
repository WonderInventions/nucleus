import S3Store from './s3/S3Store';
import DualWriteStore from './DualWriteStore';
import LocalStore from './local/LocalStore';

import { fileStrategy, s3 } from '../config';

let store: IFileStore;

switch (fileStrategy) {
  case 's3': {
    const mirror = s3.mirror;
    store = mirror
      ? new DualWriteStore(new S3Store(s3), new S3Store(mirror))
      : new S3Store();
    break;
  }
  case 'local':
  default:
    store = new LocalStore();
}

export default store;
