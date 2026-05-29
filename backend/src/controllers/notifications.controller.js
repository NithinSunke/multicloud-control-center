import {
  getNotificationSettings,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationSummary,
  updateNotificationSettings,
} from '../services/notificationStore.js';

export async function getNotifications(req, res) {
  const [notifications, summary] = await Promise.all([
    listNotifications({
      limit: req.query.limit ? Number(req.query.limit) : 100,
      status: req.query.status,
    }),
    notificationSummary(),
  ]);
  res.json({
    data: {
      generatedAt: new Date().toISOString(),
      summary,
      notifications,
    },
  });
}

export async function setNotificationRead(req, res) {
  const notification = await markNotificationRead(req.params.id, req.body?.read !== false);
  res.json({ data: { notification } });
}

export async function setAllNotificationsRead(_req, res) {
  const result = await markAllNotificationsRead();
  res.json({ data: result });
}

export async function getSettings(_req, res) {
  res.json({ data: { settings: await getNotificationSettings() } });
}

export async function saveSettings(req, res) {
  const settings = await updateNotificationSettings(req.body || {});
  res.json({ data: { settings, message: 'Notification settings saved.' } });
}
