import { Router } from 'express';
import { requireAuth } from '../controllers/auth.controller.js';
import { validateBody } from '../middleware/validateRequest.js';
import { connectorDeleteSchema, connectorSchema } from '../schemas/connector.schemas.js';
import {
  addConnector,
  chooseConnector,
  editConnector,
  getConnectors,
  removeConnector,
  verifyConnector,
} from '../controllers/connectors.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/', getConnectors);
router.post('/', validateBody(connectorSchema), addConnector);
router.put('/:id', validateBody(connectorSchema), editConnector);
router.delete('/:id', validateBody(connectorDeleteSchema), removeConnector);
router.post('/:id/select', chooseConnector);
router.post('/:id/verify', verifyConnector);

export default router;
