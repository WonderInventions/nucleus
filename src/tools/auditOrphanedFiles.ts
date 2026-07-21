/**
 * Reports store objects that the database no longer references.
 *
 * Orphans accumulate when a deletion flow removes database rows without
 * (fully) removing the stored files.  This script diffs the artifact
 * namespaces of every app/channel against the database and prints the
 * orphaned keys as JSON, one report per channel.  It is read-only: deleting
 * anything is left to the operator after reviewing the report.
 *
 * Usage (needs database + file store access, i.e. the prod config):
 *   yarn tsx src/tools/auditOrphanedFiles.ts [path/to/config.js]
 */
import driver from '../db/driver';
import store from '../files/store';
import { getAptPackageKey } from '../files/utils/apt';
import { getYumPackageKey } from '../files/utils/yum';

const ARTIFACT_SUFFIXES = ['.nupkg', '.exe', '.msi', '.zip', '.dmg', '.pkg', '.deb', '.rpm'];

const isArtifact = (key: string) => ARTIFACT_SUFFIXES.some(suffix => key.endsWith(suffix));

const main = async () => {
  let totalOrphans = 0;
  let totalBytes = 0;

  for (const app of await driver.getApps()) {
    for (const channel of app.channels) {
      const expectedKeys = new Set<string>();
      const versionNames = new Set<string>();
      for (const version of channel.versions) {
        versionNames.add(version.name);
        for (const file of version.files || []) {
          switch (file.platform) {
            case 'win32':
            case 'darwin':
              expectedKeys.add(`${app.slug}/${channel.id}/${file.platform}/${file.arch}/${file.fileName}`);
              break;
            case 'linux':
              if (file.fileName.endsWith('.deb')) {
                expectedKeys.add(getAptPackageKey(app, channel, version.name, file.fileName));
              } else if (file.fileName.endsWith('.rpm')) {
                expectedKeys.add(getYumPackageKey(app, channel, version.name, file.fileName));
              }
              break;
            default:
              break;
          }
        }
      }

      const orphans: string[] = [];

      // Artifacts in the platform directories and linux package pools that no
      // database file row points at.  Metadata files (RELEASES, repodata,
      // Packages, ...) carry none of the artifact suffixes and are skipped
      const artifactPrefixes = [
        `${app.slug}/${channel.id}/win32/`,
        `${app.slug}/${channel.id}/darwin/`,
        `${app.slug}/${channel.id}/linux/debian/binary/`,
        `${app.slug}/${channel.id}/linux/redhat/`,
      ];
      for (const prefix of artifactPrefixes) {
        const keys = await store.listFiles(prefix);
        orphans.push(...keys.filter(key => isArtifact(key) && !expectedKeys.has(key)));
      }

      // _index trees for versions the database no longer knows about
      const indexPrefix = `${app.slug}/${channel.id}/_index/`;
      const indexKeys = await store.listFiles(indexPrefix);
      orphans.push(...indexKeys.filter((key) => {
        const versionName = key.substring(indexPrefix.length).split('/')[0];
        return !versionNames.has(versionName);
      }));

      let orphanBytes = 0;
      for (const key of orphans) {
        orphanBytes += await store.getFileSize(key);
      }
      totalOrphans += orphans.length;
      totalBytes += orphanBytes;

      console.log(JSON.stringify({
        app: app.slug,
        channel: channel.id,
        channelName: channel.name,
        versionsInDatabase: versionNames.size,
        orphanCount: orphans.length,
        orphanBytes,
        orphans,
      }, null, 2));
    }
  }

  console.log(JSON.stringify({ message: 'Audit complete', totalOrphans, totalBytes }));
  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
