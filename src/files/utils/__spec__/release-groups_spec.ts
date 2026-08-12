import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { groupSavesForRelease } from '../release-groups';

const save = (platform: string, arch: string, id = `${platform}-${arch}`) => ({ platform, arch, id });

describe('groupSavesForRelease', () => {
  it('should return no groups for no saves', () => {
    assert.deepStrictEqual(groupSavesForRelease([]), []);
  });

  it('should give each darwin and win32 arch its own group', () => {
    const darwinX64 = save('darwin', 'x64');
    const darwinArm64 = save('darwin', 'arm64');
    const win32X64 = save('win32', 'x64');

    const groups = groupSavesForRelease([darwinX64, darwinArm64, win32X64]);

    assert.strictEqual(groups.length, 3);
    assert.deepStrictEqual(groups, [[darwinX64], [darwinArm64], [win32X64]]);
  });

  it('should keep saves of the same platform and arch together', () => {
    const first = save('darwin', 'x64', 'first');
    const second = save('darwin', 'x64', 'second');

    const groups = groupSavesForRelease([first, second]);

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(groups[0], [first, second]);
  });

  it('should keep every linux save in a single group regardless of arch', () => {
    const linuxX64 = save('linux', 'x64');
    const linuxIa32 = save('linux', 'ia32');
    const linuxArm64 = save('linux', 'arm64');

    const groups = groupSavesForRelease([linuxX64, linuxIa32, linuxArm64]);

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(groups[0], [linuxX64, linuxIa32, linuxArm64]);
  });

  it('should separate linux from the other platforms', () => {
    const linuxX64 = save('linux', 'x64');
    const darwinX64 = save('darwin', 'x64');
    const win32Ia32 = save('win32', 'ia32');

    const groups = groupSavesForRelease([linuxX64, darwinX64, win32Ia32]);

    assert.strictEqual(groups.length, 3);
    assert.deepStrictEqual(groups.find(group => group[0].platform === 'linux'), [linuxX64]);
  });

  it('should place every save into exactly one group', () => {
    const saves = [
      save('darwin', 'x64'),
      save('darwin', 'x64', 'second-darwin-x64'),
      save('darwin', 'arm64'),
      save('win32', 'x64'),
      save('linux', 'x64'),
      save('linux', 'arm64'),
    ];

    const groups = groupSavesForRelease(saves);

    assert.deepStrictEqual(
      groups.flat().map(s => s.id).sort(),
      saves.map(s => s.id).sort(),
    );
  });
});
