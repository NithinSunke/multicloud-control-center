import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import authRoutes from './routes/auth.routes.js';
import awsRoutes from './routes/aws.routes.js';
import azureRoutes from './routes/azure.routes.js';
import connectorRoutes from './routes/connectors.routes.js';
import gcpRoutes from './routes/gcp.routes.js';
import notificationRoutes from './routes/notifications.routes.js';
import ociRoutes from './routes/oci.routes.js';
import proxmoxApiRoutes from './routes/proxmoxApi.routes.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';

dotenv.config();

export function createServer() {
  const app = express();
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';

  app.use(requestContext);
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(
    cors({
      origin: corsOrigin,
      credentials: true,
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/aws', awsRoutes);
  app.use('/api/azure', azureRoutes);
  app.use('/api/connectors', connectorRoutes);
  app.use('/api/gcp', gcpRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/oci', ociRoutes);
  app.use('/api/proxmox', proxmoxApiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
