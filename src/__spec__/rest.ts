import { describe } from 'node:test';

describe('Rest API', () => {
  require('./healthcheck_spec');
  require('./app_spec');
  require('./channel_spec');
  require('./temporary_releases_spec');
});
