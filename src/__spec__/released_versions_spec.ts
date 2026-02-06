import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';

import * as helpers from './_helpers';

describe('released_versions endpoints', { timeout: 120000 }, () => {
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

  const uploadAndRelease = async (version: string) => {
    const fileName = `test-app-${version}.zip`;
    const fileContent = Buffer.from(`fake-content-for-${fileName}`);
    const formData = new FormData();
    formData.append('version', version);
    formData.append('platform', 'darwin');
    formData.append('arch', 'x64');
    formData.append('file', new Blob([fileContent]), fileName);

    // Upload draft
    const uploadResp = await fetch(`http://localhost:8987/rest/app/${app.id}/channel/${channel.id}/upload`, {
      method: 'POST',
      headers: { Authorization: app.token },
      body: formData,
    });
    assert.strictEqual(uploadResp.status, 200, `Upload failed for ${version}: ${await uploadResp.text()}`);

    // Get the temporary save ID
    const listResp = await helpers.request
      .get(`/app/${app.id}/channel/${channel.id}/temporary_releases`)
      .send();
    const save = listResp.body.find((s: any) => s.version === version);
    assert.ok(save, `Could not find temporary save for version ${version}`);

    // Release it
    const releaseResp = await helpers.request
      .post(`/app/${app.id}/channel/${channel.id}/temporary_releases/${save.id}/release`)
      .send();
    assert.strictEqual(releaseResp.status, 200, `Release failed for ${version}: ${JSON.stringify(releaseResp.body)}`);
  };

  const markDead = async (version: string) => {
    const resp = await helpers.request
      .post(`/app/${app.id}/channel/${channel.id}/dead`)
      .send({ version, dead: true });
    assert.strictEqual(resp.status, 200, `Mark dead failed for ${version}: ${JSON.stringify(resp.body)}`);
  };

  const getApp = async () => {
    const resp = await helpers.request.get(`/app/${app.id}`).send();
    return resp.body as NucleusApp;
  };

  describe('POST /:id/channel/:channelId/released_versions/delete_old', () => {
    it('should return 0 deleted when there are no versions', async () => {
      const response = await helpers.request
        .post(`/app/${app.id}/channel/${channel.id}/released_versions/delete_old`)
        .send({ keepCount: 20 });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.deleted, 0);
    });

    it('should delete old dead versions while keeping recent ones', async () => {
      // Create 5 versions
      await uploadAndRelease('1.0.0');
      await uploadAndRelease('2.0.0');
      await uploadAndRelease('3.0.0');
      await uploadAndRelease('4.0.0');
      await uploadAndRelease('5.0.0');

      // Mark versions 1.0.0 and 2.0.0 as dead (5.0.0 is at 100% rollout so this is allowed)
      await markDead('1.0.0');
      await markDead('2.0.0');

      // Verify all 5 versions exist
      let currentApp = await getApp();
      let ch = currentApp.channels.find(c => c.id === channel.id)!;
      assert.strictEqual(ch.versions.length, 5);

      // Delete old dead versions, keeping the 3 most recent
      const response = await helpers.request
        .post(`/app/${app.id}/channel/${channel.id}/released_versions/delete_old`)
        .send({ keepCount: 3 });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.deleted, 2, 'Should delete versions 1.0.0 and 2.0.0');

      // Verify the remaining versions
      currentApp = await getApp();
      ch = currentApp.channels.find(c => c.id === channel.id)!;
      const versionNames = ch.versions.map(v => v.name).sort();
      assert.deepStrictEqual(versionNames, ['3.0.0', '4.0.0', '5.0.0']);

      // Verify S3 index files are cleaned up
      assert.strictEqual(
        await helpers.store.hasFile(`${app.slug}/${channel.id}/_index/1.0.0/darwin/x64/test-app-1.0.0.zip`),
        false,
        'Index file for 1.0.0 should be deleted',
      );
      assert.strictEqual(
        await helpers.store.hasFile(`${app.slug}/${channel.id}/_index/2.0.0/darwin/x64/test-app-2.0.0.zip`),
        false,
        'Index file for 2.0.0 should be deleted',
      );

      // Verify kept versions still have their files
      assert.strictEqual(
        await helpers.store.hasFile(`${app.slug}/${channel.id}/_index/3.0.0/darwin/x64/test-app-3.0.0.zip`),
        true,
        'Index file for 3.0.0 should still exist',
      );
    });

    it('should not delete non-dead versions outside keepCount', async () => {
      // At this point we have 3.0.0, 4.0.0, 5.0.0 (5.0.0 at 100%)
      // Add two more versions so we have 5 total again
      await uploadAndRelease('6.0.0');
      await uploadAndRelease('7.0.0');

      // Mark only 3.0.0 as dead (7.0.0 is at 100% rollout so this is allowed)
      await markDead('3.0.0');

      // Delete with keepCount=2: versions outside top 2 (7.0.0, 6.0.0) are 5.0.0, 4.0.0, 3.0.0
      // Only 3.0.0 is dead, so only it should be deleted
      const response = await helpers.request
        .post(`/app/${app.id}/channel/${channel.id}/released_versions/delete_old`)
        .send({ keepCount: 2 });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.deleted, 1, 'Should only delete 3.0.0');

      const currentApp = await getApp();
      const ch = currentApp.channels.find(c => c.id === channel.id)!;
      const versionNames = ch.versions.map(v => v.name).sort();
      assert.deepStrictEqual(versionNames, ['4.0.0', '5.0.0', '6.0.0', '7.0.0']);
    });

    it('should return 0 deleted when no dead versions exist outside keepCount', async () => {
      // We have 4.0.0, 5.0.0, 6.0.0, 7.0.0 — none are dead
      const response = await helpers.request
        .post(`/app/${app.id}/channel/${channel.id}/released_versions/delete_old`)
        .send({ keepCount: 2 });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.deleted, 0);
    });

    it('should return 404 for an invalid channel', async () => {
      const response = await helpers.request
        .post(`/app/${app.id}/channel/99999/released_versions/delete_old`)
        .send({ keepCount: 20 });

      assert.strictEqual(response.status, 404);
      assert.strictEqual(response.body.error, 'Channel not found');
    });

    it('should return 400 if keepCount is missing', async () => {
      const response = await helpers.request
        .post(`/app/${app.id}/channel/${channel.id}/released_versions/delete_old`)
        .send();

      assert.strictEqual(response.status, 400);
    });
  });
});
