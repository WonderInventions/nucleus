import debug from 'debug';
import express from 'express';

import driver from '../db/driver';
import { createA } from '../utils/a';
import Positioner from '../files/Positioner';
import store from '../files/store';

const d = debug('nucleus:rest:admin');
const a = createA(d);

const adminRouter = express.Router();

adminRouter.get('/release-locks', a(async (req, res) => {
  const apps = await driver.getApps();
  const positioner = new Positioner(store);

  d(`admin user ${req.user?.id} is clearing all existing locks`);

  for (const app of apps) {
    for (const channel of app.channels) {
      const lock = await positioner.currentLock(app, channel);
      if (lock) {
        d('clearing lock for app:', app.slug, 'channel:', channel.id);
        await positioner.releaseLock(app, channel, lock);
      }
    }
    // Locks written before per-channel locking existed live at the app root and
    // are no longer read by anything, so purge them unconditionally
    await store.deletePath(`${app.slug}/.lock`);
  }

  d('locks cleared');

  res.json({
    success: 'Locks cleared',
  });
}));

export default adminRouter;
