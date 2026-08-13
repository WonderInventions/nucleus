import * as semver from 'semver';

export type LinuxPackageExtension = '.deb' | '.rpm';

export interface AdvertisedPackage {
  versionName: string;
  fileName: string;
}

/** Linux repos holding packages that have been positioned but are not yet advertised. */
export interface PendingLinuxRepos {
  apt: boolean;
  yum: boolean;
}

/**
 * The packages a linux repo advertises: every package of the given kind belonging to the
 * semver-greatest non-dead version that carries one.
 *
 * Both the apt and yum repos follow this one rule, and it is deliberately shared rather than
 * reimplemented per format: the two formats previously each carried their own copy in the
 * add-a-package path and another in the rebuild-the-metadata path, the copies drifted, and the
 * drift silently dropped published packages out of the metadata.
 */
export const packagesForLinuxRepo = (
  channel: NucleusChannel,
  extension: LinuxPackageExtension,
): AdvertisedPackage[] => {
  let newestVersion: NucleusVersion | undefined;
  let newestFiles: NucleusFile[] = [];

  for (const version of channel.versions) {
    if (version.dead) continue;

    const files = (version.files || []).filter(
      file => file.platform === 'linux' && file.fileName.endsWith(extension),
    );
    // Checked before the comparison below, so that a newer version carrying no package of this
    // kind -- a release that shipped without linux builds, say -- is passed over rather than
    // selected and then found to be empty, which would advertise nothing at all
    if (!files.length) continue;

    if (newestVersion && !semver.gt(version.name, newestVersion.name)) continue;

    newestVersion = version;
    newestFiles = files;
  }

  if (!newestVersion) return [];

  const versionName = newestVersion.name;
  return newestFiles.map(file => ({ versionName, fileName: file.fileName }));
};
