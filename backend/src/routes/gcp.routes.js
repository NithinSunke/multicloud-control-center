import { Router } from 'express';
import { requireAuth } from '../controllers/auth.controller.js';
import {
  attachDisk,
  createBucket,
  createDisk,
  createDiskSnapshot,
  createFirewallRule,
  createInstance,
  createMachineImage,
  createRoute,
  createSqlBackup,
  createSqlInstance,
  createSubnet,
  createVpc,
  deleteBucket,
  deleteBucketObject,
  deleteDisk,
  deleteFirewallRule,
  deleteInstance,
  deleteRoute,
  deleteSqlInstance,
  deleteSubnet,
  deleteVpc,
  detachDisk,
  getInstanceStatus,
  getInventory,
  getJobs,
  getSqlInstanceStatus,
  listBucketObjects,
  listSqlBackups,
  releaseExternalIp,
  reserveExternalIp,
  resizeDisk,
  resizeInstance,
  runInstanceAction,
  restoreSqlBackup,
  runSqlInstanceAction,
  uploadBucketObject,
} from '../controllers/gcp.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/inventory', getInventory);
router.get('/jobs', getJobs);
router.post('/instances', createInstance);
router.get('/instances/:instanceName/status', getInstanceStatus);
router.post('/instances/:instanceName/actions/:action', runInstanceAction);
router.delete('/instances/:instanceName', deleteInstance);
router.put('/instances/:instanceName/type', resizeInstance);
router.post('/instances/:instanceName/machine-images', createMachineImage);
router.post('/instances/:instanceName/disks', attachDisk);
router.delete('/instances/:instanceName/disks/:deviceName', detachDisk);
router.post('/disks', createDisk);
router.put('/disks/:diskName/resize', resizeDisk);
router.delete('/disks/:diskName', deleteDisk);
router.post('/disks/:diskName/snapshots', createDiskSnapshot);
router.post('/buckets', createBucket);
router.delete('/buckets/:bucketName', deleteBucket);
router.get('/buckets/:bucketName/objects', listBucketObjects);
router.post('/buckets/:bucketName/objects', uploadBucketObject);
router.delete('/buckets/:bucketName/objects', deleteBucketObject);
router.post('/networks/vpcs', createVpc);
router.delete('/networks/vpcs/:vpcName', deleteVpc);
router.post('/networks/subnets', createSubnet);
router.delete('/networks/subnets/:subnetName', deleteSubnet);
router.post('/networks/firewall-rules', createFirewallRule);
router.delete('/networks/firewall-rules/:firewallName', deleteFirewallRule);
router.post('/networks/routes', createRoute);
router.delete('/networks/routes/:routeName', deleteRoute);
router.post('/networks/external-ips', reserveExternalIp);
router.delete('/networks/external-ips/:addressName', releaseExternalIp);
router.post('/sql/instances', createSqlInstance);
router.get('/sql/instances/:instanceName/status', getSqlInstanceStatus);
router.post('/sql/instances/:instanceName/actions/:action', runSqlInstanceAction);
router.delete('/sql/instances/:instanceName', deleteSqlInstance);
router.get('/sql/instances/:instanceName/backups', listSqlBackups);
router.post('/sql/instances/:instanceName/backups', createSqlBackup);
router.post('/sql/instances/:instanceName/restore', restoreSqlBackup);

export default router;
