#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FunctionsEfsStack } from './functions-efs-stack';

const app = new cdk.App();

const createNewService = app.node.tryGetContext('createNewService') === 'true';

new FunctionsEfsStack(app, 'FunctionsEfsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  createNewService: createNewService,
  vpcId: process.env.VPC_ID || '<VPC_ID>',
  subnetIds: (process.env.SUBNET_IDS || '<SUBNET_ID_1>,<SUBNET_ID_2>').split(','),
  securityGroupId: process.env.SECURITY_GROUP_ID || '<SECURITY_GROUP_ID>',
  clusterName: process.env.CLUSTER_NAME || '<CLUSTER_NAME>',
  taskRoleArn: process.env.TASK_ROLE_ARN || '<TASK_ROLE_ARN>',
  executionRoleArn: process.env.EXECUTION_ROLE_ARN || '<EXECUTION_ROLE_ARN>',
  logGroupName: process.env.LOG_GROUP_NAME || '/ecs/supabase',
  containerImage: process.env.CONTAINER_IMAGE || 'supabase/edge-runtime:v1.69.28',
  serviceDiscoveryServiceId: process.env.SERVICE_DISCOVERY_ID || '<SERVICE_DISCOVERY_ID>',
  kongSecurityGroupId: process.env.KONG_SECURITY_GROUP_ID || '<KONG_SECURITY_GROUP_ID>',
});
