interface GroupableSave {
  platform: string;
  arch: string;
}

/**
 * Splits saves into sets that can be released in parallel.  Saves land in the
 * same group when releasing them shares a resource:
 *
 * * rpms are signed through the one gpg keyring, so linux stays a single group
 * * darwin/win32 saves of the same arch share a RELEASES(.json) file
 *
 * Distinct darwin/win32 arches write disjoint prefixes, so they are safe to
 * run against each other.
 */
export const groupSavesForRelease = <T extends GroupableSave>(saves: T[]): T[][] => {
  const groups = new Map<string, T[]>();
  for (const save of saves) {
    const key = save.platform === 'linux' ? 'linux' : `${save.platform}/${save.arch}`;
    const group = groups.get(key);
    if (group) {
      group.push(save);
    } else {
      groups.set(key, [save]);
    }
  }
  return [...groups.values()];
};
