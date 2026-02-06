import { Table, Column, Model, HasMany, Unique, BelongsTo, Sequelize, DataType, ForeignKey } from 'sequelize-typescript';
import { Op, QueryInterface } from 'sequelize';

import debug from 'debug';

import * as config from '../../../config';

@Table
export class App extends Model {
  @Column(DataType.STRING)
  declare name: string;

  @Column(DataType.STRING)
  declare slug: string;

  @Column(DataType.STRING)
  declare token: string;

  @HasMany(() => TeamMember)
  declare team: TeamMember[];

  @HasMany(() => Channel)
  declare channels: Channel[];
}

@Table
export class TeamMember extends Model {
  @Column(DataType.STRING)
  declare userId: string;

  @ForeignKey(() => App)
  @Column(DataType.INTEGER)
  declare appId: number;

  @BelongsTo(() => App)
  declare app: App;
}

@Table
export class Channel extends Model {
  @Unique
  @Column(DataType.STRING)
  declare stringId: string;

  @Column(DataType.STRING)
  declare name: string;

  @ForeignKey(() => App)
  @Column(DataType.INTEGER)
  declare appId: number;

  @BelongsTo(() => App)
  declare app: App;

  @HasMany(() => Version)
  declare versions: Version[];

  @HasMany(() => TemporarySave)
  declare temporarySaves: TemporarySave[];
}
// version: string, filenames: string[], arch: string, platform: NucleusPlatform//
@Table
export class TemporarySave extends Model {
  @Unique
  @Column(DataType.STRING)
  declare saveString: string;

  @Column({ type: DataType.STRING, field: 'version' })
  declare version: string;

  @Column(DataType.STRING)
  declare arch: string;

  @Column(DataType.STRING)
  declare platform: string;

  @Column(DataType.DATE)
  declare date: Date;

  @Column(DataType.STRING)
  declare cipherPassword: string;

  @ForeignKey(() => Channel)
  @Column(DataType.INTEGER)
  declare channelId: number;

  @BelongsTo(() => Channel)
  declare channel: Channel;

  @HasMany(() => TemporarySaveFile)
  declare files: TemporarySaveFile[];
}

@Table
export class TemporarySaveFile extends Model {
  @Column(DataType.STRING)
  declare name: string;

  @ForeignKey(() => TemporarySave)
  @Column(DataType.INTEGER)
  declare temporarySaveId: number;

  @BelongsTo(() => TemporarySave)
  declare temporarySave: TemporarySave;
}

@Table
export class Version extends Model {
  @Column(DataType.STRING)
  declare name: string;

  @Column(DataType.BOOLEAN)
  declare dead: boolean;

  @Column(DataType.INTEGER)
  declare rollout: number;

  @ForeignKey(() => Channel)
  @Column(DataType.INTEGER)
  declare channelId: number;

  @BelongsTo(() => Channel)
  declare channel: Channel;

  @HasMany(() => File)
  declare files: File[];
}

@Table
export class File extends Model {
  @Column(DataType.STRING)
  declare fileName: string;

  @Column(DataType.STRING)
  declare platform: string;

  @Column(DataType.STRING)
  declare arch: string;

  @Column(DataType.STRING)
  declare type: string;

  @Column(DataType.STRING({ length: 40 }))
  declare sha1: string;

  @Column(DataType.STRING({ length: 64 }))
  declare sha256: string;

  @ForeignKey(() => Version)
  @Column(DataType.INTEGER)
  declare versionId: number;

  @BelongsTo(() => Version)
  declare versionRef: Version;
}

@Table
export class Migration extends Model implements NucleusMigration {
  @Column(DataType.STRING)
  declare key: string;

  @Column(DataType.STRING)
  declare friendlyName: string;

  @Column(DataType.BOOLEAN)
  declare complete: boolean;
}

const d = debug('nucleus:db:migrator');

function createAddColumnMigration<T>(columnName: string, table: typeof Model, defaultValue: T) {
  return async function addColumnToTable(queryInterface: QueryInterface) {
    const description = await queryInterface.describeTable((table as any).getTableName());
    if (Object.keys(description).indexOf(columnName) === -1) {
      await queryInterface.addColumn((table as any).getTableName() as string, columnName, {
        type: (table as any).rawAttributes[columnName].type,
      });
      await (table as any).update({
        [columnName]: defaultValue,
      }, {
        where: {
          [columnName]: {
            [Op.eq]: null,
          },
        },
      });
      d(`adding the ${columnName} column to the ${(table as any).getTableName()} table`);
    }
  };
}

const upwardsMigrations: ((queryInterface: QueryInterface) => Promise<void>)[] = [
  createAddColumnMigration('rollout', Version as unknown as typeof Model, 100),
  createAddColumnMigration('sha1', File as unknown as typeof Model, ''),
  createAddColumnMigration('sha256', File as unknown as typeof Model, ''),
];

export default async function () {
  const sequelize = new Sequelize({
    database: config.sequelize.database,
    dialect: config.sequelize.dialect as any,
    username: config.sequelize.username,
    password: config.sequelize.password,
    host: config.sequelize.host,
    port: config.sequelize.port,
    storage: config.sequelize.storage,
    logging: false,
    define: {
      freezeTableName: true,
    },
  });

  sequelize.addModels([
    File,
    Version,
    Channel,
    TeamMember,
    App,
    TemporarySave,
    TemporarySaveFile,
    Migration,
  ]);

  await sequelize.authenticate();
  await sequelize.sync();

  const queryInterface = sequelize.getQueryInterface();

  for (const migrationFn of upwardsMigrations) {
    await migrationFn(queryInterface);
  }

  return sequelize;
}
