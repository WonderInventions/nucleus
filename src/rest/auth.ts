import express from 'express';
import passport from 'passport';
import session from 'express-session';

import { initializeStrategy } from './auth-strategy';
import { sessionConfig } from '../config';

const strategyName = initializeStrategy();

passport.serializeUser((user, cb) => cb(null, user as Express.User));
passport.deserializeUser((user, cb) => cb(null, user as Express.User));

const router = express.Router();

router.get('/login', passport.authenticate(strategyName), (req, res) => {
  res.redirect('/');
});
router.get('/callback', passport.authenticate(strategyName, { failureRedirect: '/rest/auth/login' }), (req, res) => {
  res.redirect('/');
});
router.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

const sessionOpts: session.SessionOptions = {
  secret: sessionConfig.secret,
  resave: false,
  saveUninitialized: false,
};

export const authenticateRouter = router;
export const setupApp = (app: express.Application) => {
  app.use(session(sessionOpts));
  app.use(passport.initialize());
  app.use(passport.session());
};
