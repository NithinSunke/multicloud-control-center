import express, { Router } from 'express';
import { requireAuth } from '../controllers/auth.controller.js';
import { validateBody, validateParams } from '../middleware/validateRequest.js';
import {
  actionParamsSchema,
  backupBodySchema,
  backupScheduleBodySchema,
  backupScheduleParamsSchema,
  cloneBodySchema,
  cloneParamsSchema,
  confirmationBodySchema,
  createContainerBodySchema,
  createVmBodySchema,
  deleteBodySchema,
  networkConfigBodySchema,
  networkParamsSchema,
  networkStateParamsSchema,
  nodeParamsSchema,
  resourceParamsSchema,
  restoreBodySchema,
  sdnIpamBodySchema,
  sdnIpamParamsSchema,
  sdnVnetBodySchema,
  sdnVnetParamsSchema,
  sdnZoneBodySchema,
  sdnZoneParamsSchema,
  storageConfigBodySchema,
  storageConfigUpdateBodySchema,
  storageContentParamsSchema,
  storageDeleteBodySchema,
  storageIdParamsSchema,
  taskParamsSchema,
  templateBodySchema,
} from '../schemas/proxmox.schemas.js';
import {
  backupResource,
  createBackupSchedule,
  cloneVM,
  applySdn,
  convertVMToTemplate,
  createNoVncSession,
  createConsoleSession,
  createContainer,
  createNodeNetwork,
  createSdnIpam,
  createSdnVnet,
  createSdnZone,
  deleteNodeNetwork,
  deleteSdnIpam,
  deleteSdnVnet,
  deleteSdnZone,
  createStorageConfig,
  createVM,
  deleteStorageConfig,
  deleteBackupSchedule,
  deleteVM,
  getDashboard,
  getResourceStatus,
  getSdn,
  getTaskDetail,
  listIsoVolumes,
  listTemplateVolumes,
  listContainers,
  listNodeNetwork,
  listNodes,
  listStorage,
  listVMs,
  listAuditLog,
  listBackupSchedules,
  listResourceBackups,
  pollTask,
  listClusterLog,
  listTasks,
  setNodeNetworkActive,
  listStorageConfig,
  listStorageContent,
  runResourceAction,
  restoreResource,
  retryTask,
  stopTask,
  startVM,
  stopVM,
  updateStorageConfig,
  updateBackupSchedule,
  updateNodeNetwork,
  applyNodeNetwork,
} from '../controllers/proxmoxApi.controller.js';
import {
  deployTerraformStack,
  destroyTerraformStack,
  getTerraformStacks,
  planTerraformStack,
  removeTerraformStack,
  uploadTerraformStackArchive,
  validateTerraformStack,
} from '../controllers/terraformStacks.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/dashboard', getDashboard);
router.get('/nodes', listNodes);
router.get('/nodes/:node/network', validateParams(nodeParamsSchema), listNodeNetwork);
router.post('/nodes/:node/network', validateParams(nodeParamsSchema), validateBody(networkConfigBodySchema), createNodeNetwork);
router.put('/nodes/:node/network/apply', validateParams(nodeParamsSchema), applyNodeNetwork);
router.post('/nodes/:node/network/:iface/:state', validateParams(networkStateParamsSchema), setNodeNetworkActive);
router.put('/nodes/:node/network/:iface', validateParams(networkParamsSchema), validateBody(networkConfigBodySchema), updateNodeNetwork);
router.delete('/nodes/:node/network/:iface', validateParams(networkParamsSchema), validateBody(confirmationBodySchema), deleteNodeNetwork);
router.get('/sdn', getSdn);
router.put('/sdn/apply', applySdn);
router.post('/sdn/zones', validateBody(sdnZoneBodySchema), createSdnZone);
router.post('/sdn/vnets', validateBody(sdnVnetBodySchema), createSdnVnet);
router.post('/sdn/ipams', validateBody(sdnIpamBodySchema), createSdnIpam);
router.delete('/sdn/zones/:zone', validateParams(sdnZoneParamsSchema), validateBody(confirmationBodySchema), deleteSdnZone);
router.delete('/sdn/vnets/:vnet', validateParams(sdnVnetParamsSchema), validateBody(confirmationBodySchema), deleteSdnVnet);
router.delete('/sdn/ipams/:ipam', validateParams(sdnIpamParamsSchema), validateBody(confirmationBodySchema), deleteSdnIpam);
router.get('/nodes/:node/iso', validateParams(nodeParamsSchema), listIsoVolumes);
router.get('/nodes/:node/templates', validateParams(nodeParamsSchema), listTemplateVolumes);
router.get('/vms', listVMs);
router.get('/containers', listContainers);
router.get('/storage', listStorage);
router.get('/storage/config', listStorageConfig);
router.post('/storage/config', validateBody(storageConfigBodySchema), createStorageConfig);
router.put('/storage/config/:storage', validateParams(storageIdParamsSchema), validateBody(storageConfigUpdateBodySchema), updateStorageConfig);
router.delete('/storage/config/:storage', validateParams(storageIdParamsSchema), validateBody(storageDeleteBodySchema), deleteStorageConfig);
router.get('/storage/:node/:storage/content', validateParams(storageContentParamsSchema), listStorageContent);
router.get('/audit-log', listAuditLog);
router.get('/backup-schedules', listBackupSchedules);
router.post('/backup-schedules', validateBody(backupScheduleBodySchema), createBackupSchedule);
router.put('/backup-schedules/:id', validateParams(backupScheduleParamsSchema), validateBody(backupScheduleBodySchema), updateBackupSchedule);
router.delete('/backup-schedules/:id', validateParams(backupScheduleParamsSchema), validateBody(confirmationBodySchema), deleteBackupSchedule);
router.get('/logs/tasks', listTasks);
router.get('/logs/cluster', listClusterLog);
router.get('/terraform-stacks', getTerraformStacks);
router.post(
  '/terraform-stacks/upload',
  express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '50mb' }),
  uploadTerraformStackArchive,
);
router.post('/terraform-stacks/:stackId/validate', validateTerraformStack);
router.post('/terraform-stacks/:stackId/plan', planTerraformStack);
router.post('/terraform-stacks/:stackId/deploy', deployTerraformStack);
router.post('/terraform-stacks/:stackId/destroy', destroyTerraformStack);
router.delete('/terraform-stacks/:stackId', removeTerraformStack);
router.get('/resources/:type/:node/:vmid/status', validateParams(resourceParamsSchema), getResourceStatus);
router.get('/resources/:type/:node/:vmid/backups', validateParams(resourceParamsSchema), listResourceBackups);
router.post('/resources/:type/:node/:vmid/actions/:action', validateParams(actionParamsSchema), runResourceAction);
router.post('/resources/:type/:node/:vmid/backup', validateParams(resourceParamsSchema), validateBody(backupBodySchema), backupResource);
router.post('/resources/:type/:node/:vmid/restore', validateParams(resourceParamsSchema), validateBody(restoreBodySchema), restoreResource);
router.post('/resources/:type/:node/:vmid/start', validateParams(resourceParamsSchema), startVM);
router.post('/resources/:type/:node/:vmid/stop', validateParams(resourceParamsSchema), stopVM);
router.post('/vms', validateBody(createVmBodySchema), createVM);
router.post('/containers', validateBody(createContainerBodySchema), createContainer);
router.post('/vms/:node/:vmid/clone', validateParams(cloneParamsSchema), validateBody(cloneBodySchema), cloneVM);
router.post('/vms/:node/:vmid/template', validateParams(cloneParamsSchema), validateBody(templateBodySchema), convertVMToTemplate);
router.delete('/resources/:type/:node/:vmid', validateParams(resourceParamsSchema), validateBody(deleteBodySchema), deleteVM);
router.post('/resources/:type/:node/:vmid/novnc', validateParams(resourceParamsSchema), createNoVncSession);
router.post('/resources/:type/:node/:vmid/console', validateParams(resourceParamsSchema), createConsoleSession);
router.get('/tasks/:node/:upid/detail', validateParams(taskParamsSchema), getTaskDetail);
router.post('/tasks/:node/:upid/retry', validateParams(taskParamsSchema), retryTask);
router.delete('/tasks/:node/:upid', validateParams(taskParamsSchema), validateBody(confirmationBodySchema), stopTask);
router.get('/tasks/:node/:upid', validateParams(taskParamsSchema), pollTask);

export default router;
