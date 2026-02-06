import { Sequelize } from 'sequelize-typescript';

import * as semver from 'semver';

import BaseDriver from '../BaseDriver';
import getSequelize, { App, TeamMember, Channel, Version, File, TemporarySave, TemporarySaveFile, Migration } from './models';
import { randomUUID } from 'crypto';
import BaseMigration from '../../migrations/BaseMigration';
import * as config from '../../config';

const includeSettings = {
  include: [
    TeamMember,
    {
      model: Channel,
      include: [{
        model: Version,
        include: [File],
      }],
    },
  ],
};

export default class SequelizeDriver extends BaseDriver {
  private sequelize: Sequelize | null;
  
  public async ensureConnected() {
    if (this.sequelize) return;
    const sequelize = await getSequelize();
    await sequelize.sync();
    this.sequelize = sequelize;
  }

  public async createApp(owner: User, name: string, icon: Buffer) {
    await this.ensureConnected();
    const existingApps = await this.getApps();
    let attempt = 1;
    let proposedSlug = `${this.sluggify(name)}`;
    while (existingApps.some(app => app.slug === proposedSlug)) {
      attempt += 1;
      proposedSlug = `${this.sluggify(name)}${attempt}`;
    }

    const app = new App({
      name,
      slug: proposedSlug,
      token: randomUUID(),
    });
    await app.save();
    const teamMember = new TeamMember({
      userId: owner.id,
      appId: app.id,
    });
    await teamMember.save();
    await this.saveIcon(app.get(), icon);
    return (await this.getApp(app.id))!;
  }

  public async setTeam(app: NucleusApp, userIdents: string[]) {
    await this.ensureConnected();
    const members = await TeamMember.findAll<TeamMember>({
      where: {
        appId: app.id,
      },
    });
    const toAdd = new Set(userIdents);
    for (const member of members) {
      if (userIdents.indexOf(member.userId) === -1) {
        await member.destroy();
      } else {
        toAdd.delete(member.userId);
      }
    }
    for (const userId of toAdd) {
      const member = new TeamMember({
        userId,
        appId: app.id,
      });
      await member.save();
    }
    return (await this.getApp(app.id!))!;
  }

  public async resetAppToken(app: NucleusApp) {
    await this.ensureConnected();
    const rawApp = (await App.findByPk<App>(app.id))!;
    rawApp.set('token', randomUUID());
    await rawApp.save();
    return (await this.getApp(rawApp.id))!;
  }

  private fixAppStruct(app: App): NucleusApp {
    const newApp: NucleusApp = {} as any;
    newApp.id = app.id;
    newApp.name = app.name;
    newApp.slug = app.slug;
    newApp.token = app.token;
    newApp.team = (app.team || []).map(teamMember => teamMember.userId);
    newApp.channels = (app.channels || []).map(channel => this.fixChannelStruct(channel));
    return newApp;
  }

  private fixChannelStruct(channel: Channel): NucleusChannel {
    const newChannel: NucleusChannel = {} as any;
    newChannel.id = channel.stringId;
    newChannel.name = channel.name;
    newChannel.versions = this.orderVersions((channel.versions || [] as Version[]).map(v => v.get() as Version).map(version => ({
      name: version.name,
      dead: version.dead,
      rollout: version.rollout,
      files: (version.files || []).map(f => f.get() as File).map(this.fixFileStruct),
    })));
    return newChannel;
  }

  private fixFileStruct(file: File): NucleusFile {
    return {
      id: file.id,
      fileName: file.fileName,
      arch: file.arch,
      platform: file.platform as NucleusPlatform,
      type: file.type as FileType,
      sha1: file.sha1,
      sha256: file.sha256,
    };
  }

  public async getApps() {
    await this.ensureConnected();
    const apps = await App.findAll<App>(includeSettings);
    return apps.map(app => this.fixAppStruct(app.get()));
  }

  public async getApp(id: AppID) {
    await this.ensureConnected();
    const app = await App.findByPk<App>(parseInt(id, 10), includeSettings);
    if (app) return this.fixAppStruct(app.get());
    return null;
  }

  public async createChannel(app: NucleusApp, channelName: string) {
    await this.ensureConnected();
    const channel = new Channel({
      stringId: randomUUID(),
      name: channelName,
      appId: app.id,
    });
    await channel.save();
    return this.fixChannelStruct(channel.get());
  }

  public async renameChannel(app: NucleusApp, channel: NucleusChannel, newName: string) {
    await this.ensureConnected();
    const newChannel = await Channel.findOne({
      where: {
        appId: parseInt(app.id!, 10),
        stringId: channel.id,
      },
    });
    if (!newChannel) return null;
    newChannel.set('name', newName);
    await newChannel.save();
    return this.fixChannelStruct(newChannel.get());
  }

  public async getChannel(app: NucleusApp, channelId: ChannelID) {
    await this.ensureConnected();
    const channel = await Channel.findOne({
      include: [{
        model: Version,
        include: [File],
      }],
      where: {
        appId: parseInt(app.id!, 10),
        stringId: channelId,
      },
    });
    if (!channel) return null;
    return this.fixChannelStruct(channel.get());
  }

  private typeFromPlatformAndName(platform: NucleusPlatform, fileName: string): FileType {
    switch (platform) {
      case 'win32':
        if (fileName.endsWith('.exe') || fileName.endsWith('.msi')) return 'installer';
        break;
      case 'darwin':
        if (fileName.endsWith('.dmg') || fileName.endsWith('.pkg')) return 'installer';
      case 'linux':
        if (fileName.endsWith('.rpm') || fileName.endsWith('.deb')) return 'installer';
    }
    return 'update';
  }

  private fixSaveStruct(save: TemporarySave): ITemporarySave {
    return {
      id: save.id,
      saveString: save.saveString,
      platform: save.platform as NucleusPlatform,
      version: save.version,
      arch: save.arch,
      date: save.date,
      filenames: (save.files || []).map(file => file.name),
      cipherPassword: save.cipherPassword,
    };
  }

  public async getTemporarySave(temporaryId: string | number) {
    const save = await TemporarySave.findOne<TemporarySave>({
      where: {
        id: typeof temporaryId === 'string' ? parseInt(temporaryId, 10) : temporaryId,
      },
      include: [TemporarySaveFile],
    });
    if (!save) return null;
    return this.fixSaveStruct(save);
  }

  public async getTemporarySaves(app: NucleusApp, channel: NucleusChannel) {
    const rawChannel = await Channel.findOne<Channel>({
      where: {
        appId: parseInt(app.id!, 10),
        stringId: channel.id,
      },
    });

    if (!rawChannel) return [];
    const saves = await TemporarySave.findAll<TemporarySave>({
      where: {
        channelId: rawChannel.id,
      },
      include: [TemporarySaveFile],
    });
    return saves.map(save => this.fixSaveStruct(save));
  }

  public async saveTemporaryVersionFiles(app: NucleusApp, channel: NucleusChannel, version: string, filenames: string[], arch: string, platform: NucleusPlatform) {
    await this.ensureConnected();

    const rawChannel = (await Channel.findOne<Channel>({
      where: { stringId: channel.id },
    }))!;

    const save = new TemporarySave({
      platform,
      arch,
      version,
      date: new Date(),
      saveString: randomUUID(),
      cipherPassword: randomUUID(),
      channelId: rawChannel.id,
    });
    await save.save();
    
    for (const fileName of filenames) {
      const file = new TemporarySaveFile({
        name: fileName,
        temporarySaveId: save.id,
      });
      await file.save();
    }

    return this.fixSaveStruct(save);
  }
  public async registerVersionFiles(save: ITemporarySave) {
    await this.ensureConnected();

    const rawSave = (await TemporarySave.findOne<TemporarySave>({
      where: { id: save.id },
    }))!;
    const rawChannel = (await Channel.findOne<Channel>({
      where: { id: rawSave.channelId },
    }))!;
    let dbVersion = await Version.findOne<Version>({
      where: { name: save.version, channelId: rawSave.channelId },
      include: [File],
    });
    if (!dbVersion) {
      const channelHasVersion = !!(Version.findOne<Version>({
        where: { channelId: rawSave.channelId },
      }));
      dbVersion = new Version({
        name: save.version,
        dead: false,
        rollout: channelHasVersion ? config.defaultRollout : 100,
        channelId: rawChannel.id,
      });
      await dbVersion.save();
      dbVersion.files = [];
    }

    const storedFileNames: string[] = [];
    for (const fileName of save.filenames) {
      if (!(dbVersion.files || []).some(file => this.isInherentlySameFile(file.fileName, fileName) && file.arch === save.arch && file.platform === save.platform)) {
        storedFileNames.push(fileName);
        const newFile = new File({
          fileName,
          arch: save.arch,
          platform: save.platform,
          type: this.typeFromPlatformAndName(save.platform, fileName),
          versionId: dbVersion.id,
        });
        await newFile.save();
        dbVersion.files.push(newFile);
      }
    }
    const app = (await App.findOne<App>({
      where: { id: rawChannel.appId },
    }))!;
    await this.writeVersionsFileToStore(this.fixAppStruct(app), this.fixChannelStruct(rawChannel));
    await this.deleteTemporarySave(save);
    return storedFileNames;
  }

  public async deleteTemporarySave(save: ITemporarySave) {
    await this.ensureConnected();
    const rawSave = (await TemporarySave.findOne<TemporarySave>({
      where: { id: save.id },
    }))!;
    await rawSave.destroy();
  }

  public async setVersionDead(app: NucleusApp, channel: NucleusChannel, versionName: string, dead: boolean) {
    await this.ensureConnected();
    const rawChannel = await Channel.findOne<Channel>({
      where: {
        appId: parseInt(app.id!, 10),
        stringId: channel.id,
      },
      include: [Version],
    });
    if (!rawChannel || !rawChannel.versions) return (await this.getChannel(app, channel.id!))!;
    for (const version of rawChannel.versions) {
      if (version.name === versionName) {
        version.set('dead', dead);
        await version.save();
        break;
      }
    }
    await this.writeVersionsFileToStore(app, channel);
    return this.fixChannelStruct(rawChannel.get());
  }

  public async setVersionRollout(app: NucleusApp, channel: NucleusChannel, versionName: string, rollout: number) {
    await this.ensureConnected();
    const rawChannel = await Channel.findOne<Channel>({
      where: {
        appId: parseInt(app.id!, 10),
        stringId: channel.id,
      },
      include: [{
        model: Version,
        include: [File],
      }],
    });
    if (!rawChannel || !rawChannel.versions || rollout < 0 || rollout > 100) return (await this.getChannel(app, channel.id!))!;
    for (const version of rawChannel.versions) {
      if (version.name === versionName) {
        version.set('rollout', rollout);
        await version.save();
        break;
      }
    }
    await this.writeVersionsFileToStore(app, channel);
    return this.fixChannelStruct(rawChannel.get());
  }

  public async addMigrationIfNotExists(migration: BaseMigration<any>) {
    const existing = await Migration.findOne<Migration>({
      where: {
        key: migration.key,
      },
    });
    if (existing) return existing;
    return await Migration.create<Migration>({
      key: migration.key,
      friendlyName: migration.friendlyName,
      complete: (await App.count()) === 0,
    });
  }

  public async getMigrations() {
    return await Migration.findAll<Migration>();
  }

  public async storeSHAs(file: NucleusFile, hashes: HashSet) {
    const rawFile = await File.findByPk<File>(file.id);
    if (!rawFile) return null;

    rawFile.sha1 = hashes.sha1;
    rawFile.sha256 = hashes.sha256;

    await rawFile.save();

    return this.fixFileStruct(rawFile);
  }

  public async markOldVersionsAsDead(channel: NucleusChannel) {
    await this.sequelize!.query(`
      UPDATE nucleus.Version
      SET dead = true
      WHERE channelId = (SELECT id FROM nucleus.Channel c WHERE c.stringId = '${channel.id}') and !dead and id <
        (SELECT MIN(id)
         FROM (
          SELECT v.id
          FROM nucleus.Version v
          JOIN nucleus.Channel c ON v.channelId = c.id
          WHERE c.stringId = '${channel.id}'
          ORDER BY v.id DESC
          LIMIT 3) a
        );`);
  };

  public async deleteOldDeadVersions(app: NucleusApp, channel: NucleusChannel, keepCount: number): Promise<NucleusVersion[]> {
    await this.ensureConnected();
    const rawChannel = await Channel.findOne<Channel>({
      where: {
        appId: parseInt(app.id!, 10),
        stringId: channel.id,
      },
      include: [{
        model: Version,
        include: [File],
      }],
    });
    if (!rawChannel || !rawChannel.versions) return [];

    // Sort versions by semver descending
    const sorted = [...rawChannel.versions].sort((a, b) => semver.rcompare(a.name, b.name));

    // Skip the first keepCount versions, then collect dead ones from the rest
    const candidates = sorted.slice(keepCount);
    const toDelete = candidates.filter(v => v.dead);

    if (toDelete.length === 0) return [];

    const deletedVersions: NucleusVersion[] = [];
    for (const version of toDelete) {
      // Capture version info before destroying
      deletedVersions.push(this.fixVersionStruct(version));

      // Destroy associated files, then the version itself
      for (const file of (version.files || [])) {
        await file.destroy();
      }
      await version.destroy();
    }

    await this.writeVersionsFileToStore(app, channel);
    return deletedVersions;
  }

  private fixVersionStruct(version: Version): NucleusVersion {
    return {
      name: version.name,
      dead: version.dead,
      rollout: version.rollout,
      files: (version.files || []).map(f => f.get() as File).map(this.fixFileStruct),
    };
  }
}
