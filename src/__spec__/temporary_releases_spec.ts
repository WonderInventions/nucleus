import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { createReadStream } from 'fs';

import * as helpers from './_helpers';

describe('temporary_releases endpoints', { timeout: 60000 }, () => {
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

  const uploadDraft = async (version: string, fileName: string) => {
    const fileContent = Buffer.from(`fake-content-for-${fileName}`);
    const formData = new FormData();
    formData.append('version', version);
    formData.append('platform', 'darwin');
    formData.append('arch', 'x64');
    formData.append('file', new Blob([fileContent]), fileName);

    const response = await fetch(`http://localhost:8987/rest/app/${app.id}/channel/${channel.id}/upload`, {
      method: 'POST',
      headers: {
        Authorization: app.token,
      },
      body: formData,
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  };

  describe('DELETE ALL /app/:id/channel/:channelId/temporary_releases/delete_all', () => {
    it('should return success with 0 deleted when there are no drafts', async () => {
      const response = await helpers.request
        .post(`/app/${app.id}/channel/${channel.id}/temporary_releases/delete_all`)
        .send();

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.deleted, 0);
    });

    it('should delete all drafts when drafts exist', async () => {
      // Upload two drafts
      const upload1 = await uploadDraft('1.0.0', `test-app-1.0.0.dmg`);
      assert.strictEqual(upload1.status, 200, `Upload 1 failed: ${JSON.stringify(upload1.body)}`);

      const upload2 = await uploadDraft('2.0.0', `test-app-2.0.0.dmg`);
      assert.strictEqual(upload2.status, 200, `Upload 2 failed: ${JSON.stringify(upload2.body)}`);

      // Verify drafts exist
      const listResp = await helpers.request
        .get(`/app/${app.id}/channel/${channel.id}/temporary_releases`)
        .send();
      assert.strictEqual(listResp.body.length, 2, 'Should have 2 drafts');

      // Delete all
      const deleteResp = await helpers.request
        .post(`/app/${app.id}/channel/${channel.id}/temporary_releases/delete_all`)
        .send();

      assert.strictEqual(deleteResp.status, 200);
      assert.strictEqual(deleteResp.body.success, true);
      assert.strictEqual(deleteResp.body.deleted, 2);

      // Verify no drafts remain
      const afterResp = await helpers.request
        .get(`/app/${app.id}/channel/${channel.id}/temporary_releases`)
        .send();
      assert.strictEqual(afterResp.body.length, 0, 'Should have 0 drafts after delete_all');
    });

    it('should return 404 for an invalid channel', async () => {
      const response = await helpers.request
        .post(`/app/${app.id}/channel/99999/temporary_releases/delete_all`)
        .send();

      assert.strictEqual(response.status, 404);
      assert.strictEqual(response.body.error, 'Channel not found');
    });
  });

  describe('temporary saves addressed through the wrong channel', () => {
    const version = '3.0.0';
    const fileName = `test-app-${version}.dmg`;
    let otherChannel: NucleusChannel;
    let saveId: string;

    const listDrafts = async () => {
      const resp = await helpers.request
        .get(`/app/${app.id}/channel/${channel.id}/temporary_releases`)
        .send();
      return resp.body as any[];
    };

    before(async () => {
      const otherChannelResp = await helpers.request
        .post(`/app/${app.id}/channel`)
        .send({ name: 'Other' });
      assert.strictEqual(otherChannelResp.status, 200, `Channel creation failed: ${JSON.stringify(otherChannelResp.body)}`);
      otherChannel = otherChannelResp.body;

      const upload = await uploadDraft(version, fileName);
      assert.strictEqual(upload.status, 200, `Upload failed: ${JSON.stringify(upload.body)}`);

      const save = (await listDrafts()).find(s => s.version === version);
      assert.ok(save, `Could not find the draft for ${version}`);
      saveId = save.id;
    });

    // Runs before the release attempt below, which would otherwise consume the
    // draft and leave this asserting on an already-deleted save
    it('should not serve draft files through another channel', async () => {
      const response = await helpers.request
        .get(`/app/${app.id}/channel/${otherChannel.id}/temporary_releases/${saveId}/${fileName}`)
        .send();

      assert.strictEqual(response.status, 404);
      assert.strictEqual(response.body.error, 'That temporary save was not found');
    });

    it('should not release a draft owned by another channel', async () => {
      const response = await helpers.request
        .post(`/app/${app.id}/channel/${otherChannel.id}/temporary_releases/${saveId}/release`)
        .send();

      assert.strictEqual(response.status, 404, `Expected a 404: ${JSON.stringify(response.body)}`);
      assert.strictEqual(response.body.error, 'That temporary save was not found');
    });

    it('should leave the draft intact after a rejected cross-channel release', async () => {
      assert.ok(
        (await listDrafts()).some(s => `${s.id}` === `${saveId}`),
        'The draft should survive a release attempt made through the wrong channel',
      );
    });

    it('should not delete a draft owned by another channel', async () => {
      const response = await helpers.request
        .post(`/app/${app.id}/channel/${otherChannel.id}/temporary_releases/${saveId}/delete`)
        .send();

      assert.strictEqual(response.status, 404);
      assert.strictEqual(response.body.error, 'That temporary save was not found');
      assert.ok(
        (await listDrafts()).some(s => `${s.id}` === `${saveId}`),
        'The draft should survive a delete attempt made through the wrong channel',
      );
    });

    it('should still release the draft through its own channel', async () => {
      const response = await helpers.request
        .post(`/app/${app.id}/channel/${channel.id}/temporary_releases/${saveId}/release`)
        .send();

      assert.strictEqual(response.status, 200, `Release failed: ${JSON.stringify(response.body)}`);
      assert.strictEqual(
        await helpers.store.hasFile(`${app.slug}/${channel.id}/darwin/x64/${fileName}`),
        true,
        'The released artifact should be positioned on the owning channel',
      );
    });
  });
});
