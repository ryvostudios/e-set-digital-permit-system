import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

authRouter.get('/auth/me', requireAuth, (req: Request, res: Response) => {
  res.status(200).json({ auth: req.auth });
});
