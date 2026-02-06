import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';

import * as helpers from './_helpers';

describe('channel endpoints', { timeout: 60000 }, () => {
  before(async () => {
    await helpers.startTestNucleus();
  });

  after(async () => {
    await helpers.stopTestNucleus();
  });

  describe('/app/:id/channel', () => {
    describe('POST', () => {
      let app: NucleusApp;

      before(async () => {
        app = await helpers.createApp();
      });

      it('should error if an invalid app ID is provided', async () => {
        const response = await helpers.request
          .post('/app/10000/channel')
          .send();

        assert.strictEqual(response.status, 404);
        assert.strictEqual(response.body.error, 'App not found');
      });

      it('should error if no name is provided', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/channel`)
          .send();

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'Missing required body param: "name"');
      });

      it('should create the channel when a name is provided', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/channel`)
          .send({
            name: 'Stable',
          });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.name, 'Stable');
        assert.deepStrictEqual(response.body.versions, [], 'should have no versions');

        assert.strictEqual(
          await helpers.store.hasFile(`${app.slug}/${response.body.id}/versions.json`),
          true,
          'should create the versions.json file for the channel',
        );

        assert.strictEqual(
          await helpers.store.hasFile(`${app.slug}/${response.body.id}/linux/${app.slug}.repo`),
          true,
          'should create the redhat repo file',
        );

        assert.strictEqual(
          await helpers.store.hasFile(`${app.slug}/${response.body.id}/linux/debian/binary/Release`),
          true,
          'should create the debian apt repo metadata',
        );

        assert.strictEqual(
          await helpers.store.hasFile(`${app.slug}/${response.body.id}/linux/redhat/repodata/repomd.xml`),
          true,
          'should create the redhat yum repo metadata',
        );
      });

      it('should persist the created channel in the /app/:id endpoint', async () => {
        const response = await helpers.request
          .get(`/app/${app.id}`)
          .send();

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.channels.length, 1);
        assert.strictEqual(response.body.channels[0].name, 'Stable');
      });
    });
  });
});
