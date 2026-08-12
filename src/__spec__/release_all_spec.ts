import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';

import * as helpers from './_helpers';

// linux drafts are deliberately absent: the apt/yum tooling this would invoke
// is only available when the server runs on linux
describe('release_all endpoint', { timeout: 120000 }, () => {
  let app: NucleusApp;
  let channel: NucleusChannel;

  before(async () => {
    await helpers.startTestNucleus();
    app = await helpers.createApp();

    const channelResp = await helpers.request
      .post(`/app/${app.id}/channel`)
      .send({ name: 'Stable' });
    channel = channelResp.body;
  });

  after(async () => {
    await helpers.stopTestNucleus();
  });

  const contentFor = (fileName: string) => Buffer.from(`fake-content-for-${fileName}`);

  const uploadDraft = async (version: string, platform: string, arch: string, fileNames: string[], channelId: string = channel.id!) => {
    const formData = new FormData();
    formData.append('version', version);
    formData.append('platform', platform);
    formData.append('arch', arch);
    for (const fileName of fileNames) {
      formData.append(fileName, new Blob([contentFor(fileName)]), fileName);
    }

    const response = await fetch(`http://localhost:8987/rest/app/${app.id}/channel/${channelId}/upload`, {
      method: 'POST',
      headers: { Authorization: app.token },
      body: formData,
    });
    assert.strictEqual(response.status, 200, `Upload of [${fileNames.join(', ')}] failed: ${await response.text()}`);
  };

  const releaseAll = async (version: any, channelId: string = channel.id!) => {
    return helpers.request
      .post(`/app/${app.id}/channel/${channelId}/temporary_releases/release_all`)
      .send({ version });
  };

  const listDrafts = async (channelId: string = channel.id!) => {
    const response = await helpers.request
      .get(`/app/${app.id}/channel/${channelId}/temporary_releases`)
      .send();
    return response.body as ITemporarySave[];
  };

  const getChannel = async () => {
    const response = await helpers.request.get(`/app/${app.id}`).send();
    return (response.body as NucleusApp).channels.find(c => c.id === channel.id)!;
  };

  describe('releasing every draft of a version', () => {
    const version = '1.0.0';
    const darwinX64Dmg = `test-app-${version}.dmg`;
    const darwinX64Zip = `test-app-${version}.zip`;
    const darwinArm64Dmg = `test-app-${version}-arm64.dmg`;
    const win32Exe = `test-app-${version}.exe`;
    const win32Nupkg = `test-app-${version}-full.nupkg`;

    let response: { status: number; body: any };

    before(async () => {
      await uploadDraft(version, 'darwin', 'x64', [darwinX64Dmg, darwinX64Zip]);
      await uploadDraft(version, 'darwin', 'arm64', [darwinArm64Dmg]);
      await uploadDraft(version, 'win32', 'x64', [win32Exe, win32Nupkg]);
      assert.strictEqual((await listDrafts()).length, 3, 'Expected 3 drafts before releasing');

      response = await releaseAll(version);
    });

    it('should report every draft as released', () => {
      assert.strictEqual(response.status, 200, `release_all failed: ${JSON.stringify(response.body)}`);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.version, version);
      assert.strictEqual(response.body.released, 3);
      assert.strictEqual(response.body.results.length, 3);
      assert.ok(response.body.results.every((r: any) => r.success), JSON.stringify(response.body.results));
    });

    it('should position the artifacts for every platform and arch', async () => {
      for (const [key, exists] of [
        [`${app.slug}/${channel.id}/darwin/x64/${darwinX64Dmg}`, true],
        [`${app.slug}/${channel.id}/darwin/x64/${darwinX64Zip}`, true],
        [`${app.slug}/${channel.id}/darwin/arm64/${darwinArm64Dmg}`, true],
        [`${app.slug}/${channel.id}/win32/x64/${win32Exe}`, true],
        [`${app.slug}/${channel.id}/win32/x64/${win32Nupkg}`, true],
      ] as [string, boolean][]) {
        assert.strictEqual(await helpers.store.hasFile(key), exists, `Expected ${key} to exist`);
      }
    });

    it('should write the file index for every draft', async () => {
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/_index/${version}/darwin/x64/${darwinX64Dmg}`), true);
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/_index/${version}/darwin/arm64/${darwinArm64Dmg}`), true);
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/_index/${version}/win32/x64/${win32Nupkg}`), true);
    });

    it('should generate the update manifest for each arch', async () => {
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/darwin/x64/RELEASES.json`), true);
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/win32/x64/RELEASES`), true);
    });

    it('should embed the nupkg sha1 in the win32 RELEASES file', async () => {
      const releases = (await helpers.store.getFile(`${app.slug}/${channel.id}/win32/x64/RELEASES`)).toString();
      const sha1 = crypto.createHash('SHA1').update(contentFor(win32Nupkg)).digest('hex').toUpperCase();
      assert.ok(releases.includes(sha1), `RELEASES should contain ${sha1}, got: ${releases}`);
      assert.ok(releases.includes(win32Nupkg), `RELEASES should reference ${win32Nupkg}, got: ${releases}`);
    });

    it('should copy the installers into the latest position', async () => {
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/latest/darwin/x64/${app.name}.dmg`), true);
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/latest/darwin/arm64/${app.name}.dmg`), true);
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/latest/win32/x64/${app.name}.exe`), true);
    });

    it('should consume every draft', async () => {
      assert.deepStrictEqual(await listDrafts(), []);
    });

    it('should record the version with all of its files', async () => {
      const storedChannel = await getChannel();
      const storedVersion = storedChannel.versions.find(v => v.name === version)!;
      assert.ok(storedVersion, `Version ${version} should exist on the channel`);
      assert.deepStrictEqual(
        storedVersion.files.map(f => f.fileName).sort(),
        [darwinArm64Dmg, darwinX64Dmg, darwinX64Zip, win32Exe, win32Nupkg].sort(),
      );
    });
  });

  describe('release_all validation', () => {
    it('should release only the drafts matching the requested version', async () => {
      await uploadDraft('2.0.0', 'darwin', 'x64', ['test-app-2.0.0.dmg']);
      await uploadDraft('3.0.0', 'darwin', 'x64', ['test-app-3.0.0.dmg']);

      const response = await releaseAll('3.0.0');
      assert.strictEqual(response.status, 200, `release_all failed: ${JSON.stringify(response.body)}`);
      assert.strictEqual(response.body.released, 1);

      const drafts = await listDrafts();
      assert.strictEqual(drafts.length, 1, 'The 2.0.0 draft should survive');
      assert.strictEqual(drafts[0].version, '2.0.0');
      assert.strictEqual(
        await helpers.store.hasFile(`${app.slug}/${channel.id}/darwin/x64/test-app-2.0.0.dmg`),
        false,
        'The 2.0.0 draft should not have been positioned',
      );
    });

    it('should return 404 when no draft matches the version', async () => {
      const response = await releaseAll('9.9.9');

      assert.strictEqual(response.status, 404);
      assert.strictEqual(response.body.error, 'No temporary saves found for that version on this channel');
    });

    it('should return 400 when the version is missing', async () => {
      const response = await helpers.request
        .post(`/app/${app.id}/channel/${channel.id}/temporary_releases/release_all`)
        .send();

      assert.strictEqual(response.status, 400);
    });

    it('should return 404 for an invalid channel', async () => {
      const response = await releaseAll('2.0.0', '99999');

      assert.strictEqual(response.status, 404);
      assert.strictEqual(response.body.error, 'Channel not found');
    });

    it('should release two drafts that share a platform and arch', async () => {
      await uploadDraft('4.0.0', 'darwin', 'x64', ['test-app-4.0.0.dmg']);
      await uploadDraft('4.0.0', 'darwin', 'x64', ['test-app-4.0.0.zip']);

      const response = await releaseAll('4.0.0');

      assert.strictEqual(response.status, 200, `release_all failed: ${JSON.stringify(response.body)}`);
      assert.strictEqual(response.body.released, 2);
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/darwin/x64/test-app-4.0.0.dmg`), true);
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/darwin/x64/test-app-4.0.0.zip`), true);
    });

    it('should keep the previous latest installer for an arch whose draft fails', async () => {
      const partialChannelResp = await helpers.request
        .post(`/app/${app.id}/channel`)
        .send({ name: 'Partial' });
      const partialChannel: NucleusChannel = partialChannelResp.body;
      const latestArm64 = `${app.slug}/${partialChannel.id}/latest/darwin/arm64/${app.name}.dmg`;
      const latestX64 = `${app.slug}/${partialChannel.id}/latest/darwin/x64/${app.name}.dmg`;

      await uploadDraft('1.0.0', 'darwin', 'x64', ['partial-1.0.0.dmg'], partialChannel.id);
      await uploadDraft('1.0.0', 'darwin', 'arm64', ['partial-1.0.0-arm64.dmg'], partialChannel.id);
      const firstRelease = await releaseAll('1.0.0', partialChannel.id);
      assert.strictEqual(firstRelease.status, 200, `Releasing 1.0.0 failed: ${JSON.stringify(firstRelease.body)}`);

      const goodArm64 = await helpers.store.getFile(latestArm64);
      assert.deepStrictEqual(goodArm64, contentFor('partial-1.0.0-arm64.dmg'));

      await uploadDraft('2.0.0', 'darwin', 'x64', ['partial-2.0.0.dmg'], partialChannel.id);
      await uploadDraft('2.0.0', 'darwin', 'arm64', ['partial-2.0.0-arm64.dmg'], partialChannel.id);

      // Truncating the encrypted upload past its initialisation vector makes
      // only the arm64 draft fail, so the arm64 file is registered against
      // 2.0.0 but never positioned
      const arm64Draft = (await listDrafts(partialChannel.id)).find(save => save.version === '2.0.0' && save.arch === 'arm64')!;
      assert.ok(arm64Draft, 'Could not find the arm64 draft for 2.0.0');
      const arm64Payload = `${app.slug}/temp/${arm64Draft.saveString}/partial-2.0.0-arm64.dmg`;
      assert.strictEqual(await helpers.store.hasFile(arm64Payload), true, 'Expected the arm64 payload to exist before the release');
      await helpers.store.putFile(arm64Payload, Buffer.from('short'));

      const response = await releaseAll('2.0.0', partialChannel.id);

      assert.strictEqual(response.status, 500, `Expected a partial failure: ${JSON.stringify(response.body)}`);
      assert.strictEqual(response.body.released, 1);
      assert.strictEqual(response.body.failed, 1);

      assert.strictEqual(
        await helpers.store.hasFile(arm64Payload),
        false,
        'The failed draft was consumed, so its encrypted payload should not be left behind',
      );

      assert.deepStrictEqual(
        await helpers.store.getFile(latestArm64),
        goodArm64,
        'The arm64 latest installer should still be the last one that released cleanly',
      );
      assert.deepStrictEqual(
        await helpers.store.getFile(latestX64),
        contentFor('partial-2.0.0.dmg'),
        'The x64 latest installer should have been updated by the draft that succeeded',
      );
    });

    it('should return 409 and leave the drafts alone while the channel lock is held', async () => {
      await uploadDraft('5.0.0', 'darwin', 'x64', ['test-app-5.0.0.dmg']);

      await helpers.store.putFile(`${app.slug}/${channel.id}/.lock`, Buffer.from('held-by-another-operation'));
      try {
        const response = await releaseAll('5.0.0');

        assert.strictEqual(response.status, 409);
        assert.strictEqual(response.body.error, 'Release already in progress');
        assert.ok(
          (await listDrafts()).some(save => save.version === '5.0.0'),
          'The 5.0.0 draft should survive a 409',
        );
        assert.strictEqual(
          await helpers.store.hasFile(`${app.slug}/${channel.id}/darwin/x64/test-app-5.0.0.dmg`),
          false,
          'Nothing should have been positioned during a 409',
        );
      } finally {
        await helpers.store.deletePath(`${app.slug}/${channel.id}/.lock`);
      }

      const retryResponse = await releaseAll('5.0.0');
      assert.strictEqual(retryResponse.status, 200, `Retry failed: ${JSON.stringify(retryResponse.body)}`);
      assert.strictEqual(retryResponse.body.released, 1);
      assert.strictEqual(await helpers.store.hasFile(`${app.slug}/${channel.id}/darwin/x64/test-app-5.0.0.dmg`), true);
    });
  });
});
