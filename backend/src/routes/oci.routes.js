import { Router } from 'express';
import { requireAuth } from '../controllers/auth.controller.js';
import {
  backupVolume,
  cloneAutonomousDatabase,
  createAutonomousDatabase,
  createDbSystem,
  createBucket,
  createDnsView,
  createDnsZone,
  createDrg,
  createDrgAttachment,
  createGateway,
  cloneVolume,
  createFileSystem,
  createInstance,
  createInstanceImage,
  createMountTarget,
  createRouteTable,
  createSecurityList,
  createSubnet,
  createVcn,
  createRemotePeeringConnection,
  deleteCustomImage,
  deleteDatabaseResource,
  deleteBucket,
  deleteDnsRecord,
  deleteDnsZone,
  deleteDrg,
  deleteDrgAttachment,
  deleteSubnet,
  deleteRemotePeeringConnection,
  deleteVolumeBackup,
  deleteVcn,
  getAvailabilityDomains,
  generateSshKeyPair,
  getCustomImageStatus,
  getInstanceStatus,
  getAllResources,
  getAllResourcesScan,
  getResourceMap,
  getInstances,
  getInventory,
  getLaunchOptions,
  listCustomImages,
  listDatabaseResources,
  listDbVersions,
  listDbSystemNodes,
  listDnsResources,
  listDnsZoneRecords,
  listFileStorageResources,
  listNetworkResources,
  listObjectStorageResources,
  listVolumeBackups,
  listVolumeGroupResources,
  getResources,
  moveInstance,
  connectRemotePeeringConnection,
  resizeVolume,
  runInstanceAction,
  startAllResourcesScan,
  terminateInstance,
  restoreVolume,
  runAutonomousDatabaseAction,
  runDbNodeAction,
  upsertDnsRecord,
  updateInstance,
  updateDbSystem,
} from '../controllers/oci.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/inventory', getInventory);
router.get('/instances', getInstances);
router.post('/instances', createInstance);
router.get('/resources', getResources);
router.get('/availability-domains', getAvailabilityDomains);
router.get('/launch-options', getLaunchOptions);
router.get('/all-resources', getAllResources);
router.post('/all-resources/scan', startAllResourcesScan);
router.get('/all-resources/scan/:jobId', getAllResourcesScan);
router.get('/resource-map', getResourceMap);
router.get('/custom-images', listCustomImages);
router.get('/custom-images/:imageId/status', getCustomImageStatus);
router.delete('/custom-images/:imageId', deleteCustomImage);
router.get('/instances/:instanceId/status', getInstanceStatus);
router.put('/instances/:instanceId', updateInstance);
router.post('/instances/:instanceId/actions/:action', runInstanceAction);
router.delete('/instances/:instanceId', terminateInstance);
router.post('/instances/:instanceId/custom-image', createInstanceImage);
router.post('/instances/:instanceId/move', moveInstance);
router.get('/network', listNetworkResources);
router.post('/network/vcns', createVcn);
router.delete('/network/vcns/:vcnId', deleteVcn);
router.post('/network/subnets', createSubnet);
router.delete('/network/subnets/:subnetId', deleteSubnet);
router.post('/network/gateways', createGateway);
router.post('/network/drgs', createDrg);
router.delete('/network/drgs/:drgId', deleteDrg);
router.post('/network/drg-attachments', createDrgAttachment);
router.delete('/network/drg-attachments/:attachmentId', deleteDrgAttachment);
router.post('/network/remote-peering-connections', createRemotePeeringConnection);
router.post('/network/remote-peering-connections/:connectionId/connect', connectRemotePeeringConnection);
router.delete('/network/remote-peering-connections/:connectionId', deleteRemotePeeringConnection);
router.post('/network/route-tables', createRouteTable);
router.post('/network/security-lists', createSecurityList);
router.get('/dns', listDnsResources);
router.post('/dns/views', createDnsView);
router.post('/dns/zones', createDnsZone);
router.delete('/dns/zones/:zoneId', deleteDnsZone);
router.get('/dns/zones/:zoneId/records', listDnsZoneRecords);
router.put('/dns/zones/:zoneId/records', upsertDnsRecord);
router.delete('/dns/zones/:zoneId/records', deleteDnsRecord);
router.get('/object-storage', listObjectStorageResources);
router.post('/object-storage/buckets', createBucket);
router.delete('/object-storage/buckets/:bucketName', deleteBucket);
router.get('/databases', listDatabaseResources);
router.get('/databases/db-versions', listDbVersions);
router.post('/databases/ssh-keypair', generateSshKeyPair);
router.post('/databases/autonomous', createAutonomousDatabase);
router.post('/databases/autonomous/:databaseId/clone', cloneAutonomousDatabase);
router.post('/databases/autonomous/:databaseId/actions/:action', runAutonomousDatabaseAction);
router.post('/databases/db-systems', createDbSystem);
router.get('/databases/db-systems/:dbSystemId/nodes', listDbSystemNodes);
router.post('/databases/db-systems/:dbSystemId/nodes/:dbNodeId/actions/:action', runDbNodeAction);
router.put('/databases/db-systems/:dbSystemId', updateDbSystem);
router.delete('/databases/:databaseId', deleteDatabaseResource);
router.get('/file-storage', listFileStorageResources);
router.post('/file-storage/file-systems', createFileSystem);
router.post('/file-storage/mount-targets', createMountTarget);
router.get('/volume-groups/:resourceType', listVolumeGroupResources);
router.get('/volumes/:volumeType/backups', listVolumeBackups);
router.get('/volumes/:volumeType/:volumeId/backups', listVolumeBackups);
router.post('/volumes/:volumeType/:volumeId/backup', backupVolume);
router.post('/volumes/:volumeType/:volumeId/clone', cloneVolume);
router.put('/volumes/:volumeType/:volumeId/resize', resizeVolume);
router.post('/volumes/:volumeType/restore', restoreVolume);
router.delete('/volumes/:volumeType/backups/:backupId', deleteVolumeBackup);

export default router;
