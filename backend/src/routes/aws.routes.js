import { Router } from 'express';
import { requireAuth } from '../controllers/auth.controller.js';
import {
  attachVolume,
  createBucket,
  createInternetGateway,
  createInstance,
  createInstanceImage,
  createKeyPair,
  createNatGateway,
  createRdsInstance,
  createRdsSnapshot,
  createRouteTable,
  createSnapshot,
  createSubnet,
  createVolume,
  createVpc,
  deleteBucket,
  deleteBucketObject,
  deleteInternetGateway,
  deleteNatGateway,
  deleteRdsInstance,
  deleteRdsSnapshot,
  deleteRouteTable,
  deleteSnapshot,
  deleteSubnet,
  deleteVolume,
  deleteVpc,
  detachVolume,
  getBucketObject,
  getImages,
  getInventory,
  getInstanceStatus,
  getJobs,
  getKeyPairs,
  getNetworkMap,
  getRdsInstance,
  getRdsSnapshots,
  getRouteTable,
  listBucketObjects,
  putBucketObject,
  restoreRdsInstance,
  runRdsAction,
  runInstanceAction,
  terminateInstance,
  resizeVolume,
  updateBucketVersioning,
  updateInstanceType,
  updateSecurityGroupRule,
} from '../controllers/aws.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/jobs', getJobs);
router.get('/inventory', getInventory);
router.get('/images', getImages);
router.get('/key-pairs', getKeyPairs);
router.post('/key-pairs', createKeyPair);
router.post('/instances', createInstance);
router.get('/instances/:instanceId/status', getInstanceStatus);
router.post('/instances/:instanceId/actions/:action', runInstanceAction);
router.delete('/instances/:instanceId', terminateInstance);
router.post('/instances/:instanceId/ami', createInstanceImage);
router.put('/instances/:instanceId/type', updateInstanceType);
router.post('/instances/:instanceId/volumes', attachVolume);
router.delete('/instances/:instanceId/volumes/:volumeId', detachVolume);
router.get('/network-map', getNetworkMap);
router.get('/route-tables/:routeTableId', getRouteTable);
router.post('/vpcs', createVpc);
router.delete('/vpcs/:vpcId', deleteVpc);
router.post('/subnets', createSubnet);
router.delete('/subnets/:subnetId', deleteSubnet);
router.post('/route-tables', createRouteTable);
router.delete('/route-tables/:routeTableId', deleteRouteTable);
router.post('/internet-gateways', createInternetGateway);
router.delete('/internet-gateways/:internetGatewayId', deleteInternetGateway);
router.post('/nat-gateways', createNatGateway);
router.delete('/nat-gateways/:natGatewayId', deleteNatGateway);
router.post('/security-groups/:groupId/rules', updateSecurityGroupRule);
router.get('/rds/snapshots', getRdsSnapshots);
router.delete('/rds/snapshots/:snapshotIdentifier', deleteRdsSnapshot);
router.post('/rds/instances', createRdsInstance);
router.post('/rds/restore', restoreRdsInstance);
router.get('/rds/instances/:dbInstanceIdentifier', getRdsInstance);
router.post('/rds/instances/:dbInstanceIdentifier/actions/:action', runRdsAction);
router.post('/rds/instances/:dbInstanceIdentifier/snapshots', createRdsSnapshot);
router.delete('/rds/instances/:dbInstanceIdentifier', deleteRdsInstance);
router.post('/volumes', createVolume);
router.put('/volumes/:volumeId/size', resizeVolume);
router.delete('/volumes/:volumeId', deleteVolume);
router.post('/volumes/:volumeId/snapshots', createSnapshot);
router.delete('/snapshots/:snapshotId', deleteSnapshot);
router.post('/buckets', createBucket);
router.delete('/buckets/:bucketName', deleteBucket);
router.put('/buckets/:bucketName/versioning', updateBucketVersioning);
router.get('/buckets/:bucketName/objects', listBucketObjects);
router.get('/buckets/:bucketName/object', getBucketObject);
router.put('/buckets/:bucketName/objects', putBucketObject);
router.delete('/buckets/:bucketName/objects', deleteBucketObject);

export default router;
