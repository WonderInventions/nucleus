import { RequestHandler } from 'express';
import debug from 'debug';

export const createA = (d: debug.IDebugger) => (handler: RequestHandler): RequestHandler => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (err) {
    d(`Unhandled error: ${req.url}`);
    d(err);
    res.status(500).json({ error: 'Something went wrong...' });
  }
};
