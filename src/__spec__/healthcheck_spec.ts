import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';

import * as helpers from './_helpers';

describe('healthcheck endpoints', () => {
  before(async () => {
    await helpers.startTestNucleus();
  });

  describe('/healthcheck', () => {
    describe('GET', () => {
      it('should respond 200 OK', async () => {
        const response = await helpers.request
          .get('/healthcheck')
          .send();

        assert.strictEqual(response.status, 200);
      });

      it('should response with a JSON body', async () => {
        const response = await helpers.request
          .get('/healthcheck')
          .send();

        assert.deepStrictEqual(response.body, { alive: true });
      });
    });
  });

  describe('/deepcheck', () => {
    describe('GET', () => {
      it('should respond 200 OK', async () => {
        const response = await helpers.request
          .get('/deepcheck')
          .send();

        assert.strictEqual(response.status, 200);
      });

      it('should respond with a JSON body', async () => {
        const response = await helpers.request
          .get('/deepcheck')
          .send();

        assert.deepStrictEqual(response.body, { alive: true });
      });
    });
  });

  after(async () => {
    await helpers.stopTestNucleus();
  });
});
