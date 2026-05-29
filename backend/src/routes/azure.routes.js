import { Router } from 'express';
import { requireAuth } from '../controllers/auth.controller.js';
import {
  createBlobContainer,
  createDiskSnapshot,
  createFileShare,
  createManagedDisk,
  createNetworkResource,
  createDatabaseResource,
  createSqlDatabase,
  createStorageAccount,
  createVm,
  createVmImage,
  createVmRestorePoint,
  createVmSnapshot,
  deleteBlob,
  deleteBlobContainer,
  deleteDiskSnapshot,
  deleteFileShare,
  deleteManagedDisk,
  deleteNetworkResource,
  deleteDatabaseResource,
  deleteSqlDatabase,
  deleteStorageAccount,
  deleteVm,
  getBlobs,
  getInventory,
  getJobs,
  refreshDatabaseResource,
  refreshVmStatus,
  resizeManagedDisk,
  resizeVm,
  runSqlDatabaseAction,
  runDatabaseResourceAction,
  runVmAction,
  scaleSqlDatabase,
  uploadBlob,
} from '../controllers/azure.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/jobs', getJobs);
router.get('/inventory', getInventory);
router.post('/vms', createVm);
router.post('/vms/status', refreshVmStatus);
router.post('/vms/actions/:action', runVmAction);
router.put('/vms/size', resizeVm);
router.post('/vms/snapshots', createVmSnapshot);
router.post('/vms/images', createVmImage);
router.post('/vms/restore-points', createVmRestorePoint);
router.delete('/vms', deleteVm);
router.post('/vms/:vmId/status', refreshVmStatus);
router.post('/vms/:vmId/actions/:action', runVmAction);
router.put('/vms/:vmId/size', resizeVm);
router.post('/vms/:vmId/snapshots', createVmSnapshot);
router.post('/vms/:vmId/images', createVmImage);
router.post('/vms/:vmId/restore-points', createVmRestorePoint);
router.delete('/vms/:vmId', deleteVm);
router.post('/storage/accounts', createStorageAccount);
router.delete('/storage/accounts', deleteStorageAccount);
router.delete('/storage/accounts/:accountId', deleteStorageAccount);
router.post('/network/resources', createNetworkResource);
router.delete('/network/resources', deleteNetworkResource);
router.delete('/network/resources/:resourceId', deleteNetworkResource);
router.post('/databases/resources', createDatabaseResource);
router.post('/databases/resources/status', refreshDatabaseResource);
router.post('/databases/resources/:resourceId/status', refreshDatabaseResource);
router.post('/databases/resources/actions/:action', runDatabaseResourceAction);
router.post('/databases/resources/:resourceId/actions/:action', runDatabaseResourceAction);
router.delete('/databases/resources', deleteDatabaseResource);
router.delete('/databases/resources/:resourceId', deleteDatabaseResource);
router.post('/databases/sql', createSqlDatabase);
router.put('/databases/sql/scale', scaleSqlDatabase);
router.put('/databases/sql/:databaseId/scale', scaleSqlDatabase);
router.post('/databases/sql/actions/:action', runSqlDatabaseAction);
router.post('/databases/sql/:databaseId/actions/:action', runSqlDatabaseAction);
router.delete('/databases/sql', deleteSqlDatabase);
router.delete('/databases/sql/:databaseId', deleteSqlDatabase);
router.post('/storage/blob-containers', createBlobContainer);
router.delete('/storage/blob-containers', deleteBlobContainer);
router.delete('/storage/blob-containers/:containerId', deleteBlobContainer);
router.post('/storage/file-shares', createFileShare);
router.delete('/storage/file-shares', deleteFileShare);
router.delete('/storage/file-shares/:shareId', deleteFileShare);
router.get('/storage/blobs', getBlobs);
router.post('/storage/blobs', uploadBlob);
router.delete('/storage/blobs/:blobName', deleteBlob);
router.delete('/storage/blobs', deleteBlob);
router.post('/storage/disks', createManagedDisk);
router.put('/storage/disks/resize', resizeManagedDisk);
router.put('/storage/disks/:diskId/resize', resizeManagedDisk);
router.delete('/storage/disks', deleteManagedDisk);
router.delete('/storage/disks/:diskId', deleteManagedDisk);
router.post('/storage/snapshots', createDiskSnapshot);
router.delete('/storage/snapshots', deleteDiskSnapshot);
router.delete('/storage/snapshots/:snapshotId', deleteDiskSnapshot);

export default router;
