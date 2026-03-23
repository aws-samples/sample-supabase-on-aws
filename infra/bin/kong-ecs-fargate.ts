#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SupabaseStack } from '../lib/supabase-stack';

const app = new cdk.App();

// Unified Supabase Stack
// Note: ECR repositories should be created by build-and-push-images.sh before deployment
const supabaseStack = new SupabaseStack(app, 'SupabaseStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
  },
  description: 'Supabase on AWS - VPC, ECS Cluster, ALB, Services (Kong, Functions, Project Service)',
});
