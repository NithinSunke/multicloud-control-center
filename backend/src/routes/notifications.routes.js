import { Router } from 'express';
import { requireAuth } from '../controllers/auth.controller.js';
import {
  getNotifications,
  getSettings,
  saveSettings,
  setAllNotificationsRead,
  setNotificationRead,
} from '../controllers/notifications.controller.js';
import { validateBody } from '../middleware/validateRequest.js';
import { notificationReadBodySchema, notificationSettingsBodySchema } from '../schemas/notification.schemas.js';

const router = Router();

router.use(requireAuth);

router.get('/', getNotifications);
router.patch('/read-all', setAllNotificationsRead);
router.patch('/:id/read', validateBody(notificationReadBodySchema), setNotificationRead);
router.get('/settings', getSettings);
router.put('/settings', validateBody(notificationSettingsBodySchema), saveSettings);

export default router;
