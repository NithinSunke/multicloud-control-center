import { Router } from 'express';
import { login, logout, me, requireAuth } from '../controllers/auth.controller.js';
import { validateBody } from '../middleware/validateRequest.js';
import { loginSchema } from '../schemas/auth.schemas.js';

const router = Router();

router.post('/login', validateBody(loginSchema), login);
router.post('/logout', logout);
router.get('/me', requireAuth, me);

export default router;
