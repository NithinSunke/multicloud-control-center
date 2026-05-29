import { createServer } from './src/app.js';
import { validateEnv } from './src/config/env.js';
import { createServer as createHttpServer } from 'http';
import { attachConsoleWebSocketProxy } from './src/services/consoleSessions.js';
import { startBackupScheduler } from './src/services/backupScheduler.js';
import { initializeOciInventoryStore } from './src/services/ociInventoryCache.js';
import { logger } from './src/utils/logger.js';

validateEnv();
await initializeOciInventoryStore();

const port = Number(process.env.PORT || 4000);
const app = createServer();
const server = createHttpServer(app);

attachConsoleWebSocketProxy(server);
startBackupScheduler();

server.listen(port, () => {
  logger.info('api_listening', { port });
});
