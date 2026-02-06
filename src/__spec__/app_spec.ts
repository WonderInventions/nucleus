import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';

import * as helpers from './_helpers';

describe('app endpoints', () => {
  before(async () => {
    await helpers.startTestNucleus();
  });

  after(async () => {
    await helpers.stopTestNucleus();
  });

  describe('/app', () => {
    describe('POST', () => {
      it('should error if no name is provided', async () => {
        const response = await helpers.request
          .post('/app')
          .send();

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'Missing required body param: "name"');
      });

      it('should error if an empty name is provided', async () => {
        const response = await helpers.request
          .post('/app')
          .field('name', '')
          .send();

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'Your app name can not be an empty string');
      });

      it('should error if no icon is provided', async () => {
        const response = await helpers.request
          .post('/app')
          .field('name', 'Test App')
          .send();

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'Missing icon file');
      });

      it('should error if a reserved name is provided', async () => {
        const response = await helpers.request
          .post('/app')
          .field('name', '__healthcheck')
          .send();

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'You can not call your application __healthcheck');
      });

      it('should create an app with valid params', async () => {
        const response = await helpers.request
          .post('/app')
          .field('name', 'Test App')
          .attach('icon', createReadStream(path.resolve(__dirname, 'fixtures', 'icon.png')))
          .send();

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.name, 'Test App');
        assert.strictEqual(response.body.slug, 'Test-App', 'should sanitize the name into a slug');
        assert.deepStrictEqual(response.body.team, ['test-user'], 'the initial team should just be the test user');
        assert.deepStrictEqual(response.body.channels, [], 'should have no channels initially');
        assert.ok(response.body.token.length > 0, 'should have a non zero length random string token');
      });

      it('should create an app with de-duped slug if the same app name already exists', async () => {
        const response = await helpers.request
          .post('/app')
          .field('name', 'Test App')
          .attach('icon', createReadStream(path.resolve(__dirname, 'fixtures', 'icon.png')))
          .send();

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.slug, 'Test-App2', 'should dedupe the name into a slug');
      });

      it('should put the app icon in a known position in the file store', async () => {
        assert.strictEqual(await helpers.store.hasFile('Test-App/icon.png'), true);
        assert.deepStrictEqual(
          await helpers.store.getFile('Test-App/icon.png'),
          await fs.readFile(path.resolve(__dirname, 'fixtures', 'icon.png')),
        );
      });

      it('should convert the app icon to a .ico file and put it in a known position in the file store', async () => {
        assert.strictEqual(await helpers.store.hasFile('Test-App/icon.ico'), true);
      });
    });

    describe('GET', () => {
      it('should list all the apps', async () => {
        const response = await helpers.request
          .get('/app')
          .send();

        assert.strictEqual(response.body.length, 2);
        assert.strictEqual(response.body[0].slug, 'Test-App');
        assert.strictEqual(response.body[1].slug, 'Test-App2');
      });
    });
  });

  describe('/app/:id', () => {
    describe('GET', () => {
      it('should return not found when given an invalid app ID', async () => {
        const response = await helpers.request
          .get('/app/500')
          .send();

        assert.strictEqual(response.status, 404);
      });

      it('should return the app when given a valid app ID', async () => {
        const app = await helpers.createApp();
        const response = await helpers.request
          .get(`/app/${app.id}`)
          .send();

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(response.body, app);
      });
    });
  });

  describe('/app/:id/icon', () => {
    describe('POST', () => {
      let app: NucleusApp;

      before(async () => {
        app = await helpers.createApp();
      });

      it('should error if no icon is provided', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/icon`)
          .send();

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'Missing icon file');
      });

      it('should succeed if an icon is provided', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/icon`)
          .attach('icon', createReadStream(path.resolve(__dirname, 'fixtures', 'icon2.png')))
          .send();

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(response.body, { success: true });

        assert.strictEqual(await helpers.store.hasFile(`${app.slug}/icon.png`), true);
        assert.strictEqual(await helpers.store.hasFile(`${app.slug}/icon.ico`), true);
        assert.deepStrictEqual(
          await helpers.store.getFile(`${app.slug}/icon.png`),
          await fs.readFile(path.resolve(__dirname, 'fixtures', 'icon2.png')),
        );
      });
    });
  });

  describe('/app/:id/refresh_token', () => {
    describe('POST', () => {
      let app: NucleusApp;

      before(async () => {
        app = await helpers.createApp();
      });

      it('should regenerate the token for the given app', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/refresh_token`)
          .send();

        assert.strictEqual(response.status, 200);
        assert.notStrictEqual(response.body.token, app.token);
      });

      it('should persist the change to the token', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/refresh_token`)
          .send();

        assert.strictEqual(response.status, 200);
        assert.notStrictEqual(response.body.token, app.token);

        const appResponse = await helpers.request
          .get(`/app/${app.id}`)
          .send();

        assert.strictEqual(appResponse.body.token, response.body.token);
      });
    });
  });

  describe('/app/:id/team', () => {
    describe('POST', () => {
      let app: NucleusApp;

      before(async () => {
        app = await helpers.createApp();
      });

      it('should error if no team is provided', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/team`)
          .send();

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'Missing required body param: "team"');
      });

      it('should error if the provided team is invalid JSON', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/team`)
          .send({
            team: 'abc[]',
          });

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'Provided parameter "team" is not valid JSON');
      });

      it('should error if the provided team is not an array', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/team`)
          .send({
            team: '"foo"',
          });

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'Bad team');
      });

      it('should error if the provided team does not contain the current user', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/team`)
          .send({
            team: '[]',
          });

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'Bad team');
      });

      it('should update the team when given a valid team', async () => {
        const response = await helpers.request
          .post(`/app/${app.id}/team`)
          .send({
            team: '["test-user","test","new"]',
          });

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(response.body.team.sort(), ['test-user', 'test', 'new'].sort());
      });

      it('should persist the update to the team when given a valid team', async () => {
        await helpers.request
          .post(`/app/${app.id}/team`)
          .send({
            team: '["test-user","thing"]',
          });

        const response = await helpers.request
          .get(`/app/${app.id}`)
          .send();

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(response.body.team.sort(), ['test-user', 'thing'].sort());
      });
    });
  });
});
