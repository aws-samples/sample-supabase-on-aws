import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as custom_resources from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface FunctionsEfsStackProps extends cdk.StackProps {
  createNewService?: boolean;
  vpcId: string;
  subnetIds: string[];
  securityGroupId: string;
  clusterName: string;
  taskRoleArn: string;
  executionRoleArn: string;
  logGroupName?: string;
  containerImage?: string;
  serviceDiscoveryNamespaceId?: string;
  serviceDiscoveryServiceId?: string;
  kongSecurityGroupId?: string;
  // Worker 配置
  workerMemoryMb?: number;    // Worker 内存限制 (MB)，默认 128
  workerTimeoutMs?: number;   // Worker 超时时间 (ms)，默认 60000
}

export class FunctionsEfsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FunctionsEfsStackProps) {
    super(scope, id, props);
    
    const createNewService = props.createNewService ?? false;

    // 引用现有 VPC
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
      vpcId: props.vpcId,
    });

    // 引用现有 ECS 集群
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'ExistingCluster', {
      clusterName: props.clusterName,
      vpc: vpc,
      securityGroups: [],
    });

    // 创建 EFS 文件系统
    const fileSystem = new efs.FileSystem(this, 'FunctionsFileSystem', {
      vpc: vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,  // 改为 Elastic 模式，自动扩展吞吐量
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      securityGroup: ec2.SecurityGroup.fromSecurityGroupId(this, 'EfsSG', props.securityGroupId),
      vpcSubnets: {
        subnets: props.subnetIds.map((id, idx) => 
          ec2.Subnet.fromSubnetId(this, `EfsSubnet${idx}`, id)
        ),
      },
    });

    // 创建 EFS Access Point
    const accessPoint = new efs.AccessPoint(this, 'FunctionsAccessPoint', {
      fileSystem: fileSystem,
      path: '/functions',
      posixUser: {
        uid: '1000',
        gid: '1000',
      },
      createAcl: {
        ownerUid: '1000',
        ownerGid: '1000',
        permissions: '755',
      },
    });

    // 输出 EFS ID 和 Access Point ID
    new cdk.CfnOutput(this, 'FileSystemId', {
      value: fileSystem.fileSystemId,
      description: 'EFS File System ID',
      exportName: 'FunctionsEfsId',
    });

    new cdk.CfnOutput(this, 'AccessPointId', {
      value: accessPoint.accessPointId,
      description: 'EFS Access Point ID',
      exportName: 'FunctionsAccessPointId',
    });

    // 配置安全组规则
    const functionsSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this, 
      'FunctionsSG', 
      props.securityGroupId
    );
    
    // 允许从 Kong 安全组访问 functions 服务端口 8080
    if (props.kongSecurityGroupId) {
      functionsSecurityGroup.addIngressRule(
        ec2.Peer.securityGroupId(props.kongSecurityGroupId),
        ec2.Port.tcp(8080),
        'Allow Kong to access functions service on port 8080'
      );
    }

    // 如果需要创建新服务
    if (createNewService) {
      this.createFunctionsService(vpc, cluster, fileSystem, accessPoint, props);
    } else {
      // 更新现有服务
      this.updateExistingService(vpc, cluster, fileSystem, accessPoint, props);
    }
  }

  private updateExistingService(
    vpc: ec2.IVpc,
    cluster: ecs.ICluster,
    fileSystem: efs.FileSystem,
    accessPoint: efs.AccessPoint,
    props: FunctionsEfsStackProps
  ) {
    const taskRole = iam.Role.fromRoleArn(this, 'TaskRole', props.taskRoleArn);
    const executionRole = iam.Role.fromRoleArn(this, 'ExecutionRole', props.executionRoleArn);

    // 添加 EFS 访问权限到角色
    const addPolicyToRole = new cdk.CustomResource(this, 'AddEfsPolicyToRoles', {
      serviceToken: this.createAddPolicyProvider(fileSystem.fileSystemId).serviceToken,
      properties: {
        TaskRoleName: props.taskRoleArn.split('/').pop(),
        ExecutionRoleName: props.executionRoleArn.split('/').pop(),
        FileSystemId: fileSystem.fileSystemId,
        Region: cdk.Stack.of(this).region,
        Account: cdk.Stack.of(this).account,
      },
    });

    // 创建新的任务定义
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'FunctionsTask', {
      family: 'SupabaseStackFunctionsTaskA74FCAFB',
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: taskRole,
      executionRole: executionRole,
    });

    const volumeName = 'functions-volume';
    taskDefinition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    const container = taskDefinition.addContainer('functions-service', {
      image: ecs.ContainerImage.fromRegistry(
        props.containerImage || 'supabase/edge-runtime:v1.69.28'
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'functions-service',
        logGroup: logs.LogGroup.fromLogGroupName(
          this, 
          'LogGroup', 
          props.logGroupName || '/ecs/supabase'
        ),
      }),
      environment: {
        PROJECT_REF: 'default',
        PORT: '8080',
        WORKER_MEMORY_MB: (props.workerMemoryMb || 128).toString(),
        WORKER_TIMEOUT_MS: (props.workerTimeoutMs || 60000).toString(),
      },
      entryPoint: ['sh', '-c'],
      command: ['mkdir -p /home/deno/functions/main && printf "import { serve } from \\"https://deno.land/std@0.131.0/http/server.ts\\"\n\nserve((req) => {\n  const path = new URL(req.url).pathname;\n  if (path === \\"/health\\") {\n    return new Response(JSON.stringify({status: \\"ok\\"}), {headers: {\\"Content-Type\\": \\"application/json\\"}});\n  }\n  return new Response(JSON.stringify({message: \\"Functions ready\\"}), {headers: {\\"Content-Type\\": \\"application/json\\"}});\n})" > /home/deno/functions/main/index.ts && /usr/local/bin/edge-runtime start --main-service /home/deno/functions/main -p 8080'],
    });

    container.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    container.addMountPoints({
      sourceVolume: volumeName,
      containerPath: '/home/deno/functions',
      readOnly: false,
    });

    // 使用 Custom Resource 更新现有服务
    const updateService = new cdk.CustomResource(this, 'UpdateFunctionsService', {
      serviceToken: this.createUpdateServiceProvider(taskDefinition).serviceToken,
      properties: {
        ClusterName: props.clusterName,
        ServiceName: 'functions-service',
        TaskDefinition: taskDefinition.taskDefinitionArn,
        DesiredCount: 1,
        ServiceRegistries: props.serviceDiscoveryServiceId ? JSON.stringify([{
          registryArn: `arn:aws:servicediscovery:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:service/${props.serviceDiscoveryServiceId}`
        }]) : undefined,
      },
    });

    fileSystem.connections.allowDefaultPortFrom(
      ec2.SecurityGroup.fromSecurityGroupId(this, 'ServiceSG', props.securityGroupId)
    );

    new cdk.CfnOutput(this, 'TaskDefinitionArn', {
      value: taskDefinition.taskDefinitionArn,
      description: 'New Task Definition ARN',
    });

    new cdk.CfnOutput(this, 'UpdateInstructions', {
      value: `Service will be updated with task definition: ${taskDefinition.taskDefinitionArn}`,
      description: 'Service update status',
    });
  }

  private createAddPolicyProvider(fileSystemId: string) {
    const onEventHandler = new cdk.aws_lambda.Function(this, 'AddPolicyHandler', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline(`
import boto3
import json

iam = boto3.client('iam')

def handler(event, context):
    request_type = event['RequestType']
    props = event['ResourceProperties']
    
    if request_type == 'Create' or request_type == 'Update':
        try:
            policy_document = {
                "Version": "2012-10-17",
                "Statement": [{
                    "Effect": "Allow",
                    "Action": [
                        "elasticfilesystem:ClientMount",
                        "elasticfilesystem:ClientWrite",
                        "elasticfilesystem:ClientRootAccess"
                    ],
                    "Resource": f"arn:aws:elasticfilesystem:{props['Region']}:{props['Account']}:file-system/{props['FileSystemId']}"
                }]
            }
            
            # 添加策略到任务角色
            iam.put_role_policy(
                RoleName=props['TaskRoleName'],
                PolicyName='EFSAccessPolicy',
                PolicyDocument=json.dumps(policy_document)
            )
            
            # 添加策略到执行角色
            iam.put_role_policy(
                RoleName=props['ExecutionRoleName'],
                PolicyName='EFSAccessPolicy',
                PolicyDocument=json.dumps(policy_document)
            )
            
            return {
                'PhysicalResourceId': f"efs-policy-{props['FileSystemId']}",
                'Data': {'Status': 'Success'}
            }
        except Exception as e:
            print(f"Error adding policy: {str(e)}")
            raise
    
    return {'PhysicalResourceId': f"efs-policy-{props['FileSystemId']}"}
      `),
      timeout: cdk.Duration.minutes(2),
    });

    onEventHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PutRolePolicy', 'iam:GetRolePolicy'],
      resources: ['*'],
    }));

    return new cdk.custom_resources.Provider(this, 'AddPolicyProvider', {
      onEventHandler: onEventHandler,
    });
  }

  private createUpdateServiceProvider(taskDefinition: ecs.TaskDefinition) {
    const onEventHandler = new cdk.aws_lambda.Function(this, 'UpdateServiceHandler', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline(`
import boto3
import json

ecs = boto3.client('ecs')

def handler(event, context):
    request_type = event['RequestType']
    props = event['ResourceProperties']
    
    if request_type == 'Create' or request_type == 'Update':
        try:
            update_params = {
                'cluster': props['ClusterName'],
                'service': props['ServiceName'],
                'taskDefinition': props['TaskDefinition'],
                'desiredCount': int(props['DesiredCount']),
                'forceNewDeployment': True
            }
            
            # 添加服务发现配置
            if 'ServiceRegistries' in props and props['ServiceRegistries']:
                import json
                update_params['serviceRegistries'] = json.loads(props['ServiceRegistries'])
            
            response = ecs.update_service(**update_params)
            return {
                'PhysicalResourceId': props['ServiceName'],
                'Data': {
                    'ServiceArn': response['service']['serviceArn']
                }
            }
        except Exception as e:
            print(f"Error updating service: {str(e)}")
            raise
    
    return {'PhysicalResourceId': props['ServiceName']}
      `),
      timeout: cdk.Duration.minutes(5),
    });

    onEventHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
      resources: ['*'],
    }));

    onEventHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskDefinition.taskRole.roleArn, taskDefinition.executionRole!.roleArn],
    }));

    return new cdk.custom_resources.Provider(this, 'UpdateServiceProvider', {
      onEventHandler: onEventHandler,
    });
  }

  private createFunctionsService(
    vpc: ec2.IVpc,
    cluster: ecs.ICluster,
    fileSystem: efs.FileSystem,
    accessPoint: efs.AccessPoint,
    props: FunctionsEfsStackProps
  ) {
    const taskRole = iam.Role.fromRoleArn(this, 'TaskRole', props.taskRoleArn);
    const executionRole = iam.Role.fromRoleArn(this, 'ExecutionRole', props.executionRoleArn);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'FunctionsTask', {
      family: 'SupabaseStackFunctionsTaskA74FCAFB',
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: taskRole,
      executionRole: executionRole,
    });

    const volumeName = 'functions-volume';
    taskDefinition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    const container = taskDefinition.addContainer('functions-service', {
      image: ecs.ContainerImage.fromRegistry(
        props.containerImage || 'supabase/edge-runtime:v1.69.28'
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'functions-service',
        logGroup: logs.LogGroup.fromLogGroupName(
          this, 
          'LogGroup', 
          props.logGroupName || '/ecs/supabase'
        ),
      }),
      environment: {
        PROJECT_REF: 'default',
        PORT: '8080',
        WORKER_MEMORY_MB: (props.workerMemoryMb || 128).toString(),
        WORKER_TIMEOUT_MS: (props.workerTimeoutMs || 60000).toString(),
      },
      entryPoint: ['sh', '-c'],
      command: ['mkdir -p /home/deno/functions/main && printf "import { serve } from \\"https://deno.land/std@0.131.0/http/server.ts\\"\n\nserve((req) => {\n  const path = new URL(req.url).pathname;\n  if (path === \\"/health\\") {\n    return new Response(JSON.stringify({status: \\"ok\\"}), {headers: {\\"Content-Type\\": \\"application/json\\"}});\n  }\n  return new Response(JSON.stringify({message: \\"Functions ready\\"}), {headers: {\\"Content-Type\\": \\"application/json\\"}});\n})" > /home/deno/functions/main/index.ts && /usr/local/bin/edge-runtime start --main-service /home/deno/functions/main -p 8080'],
    });

    container.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    container.addMountPoints({
      sourceVolume: volumeName,
      containerPath: '/home/deno/functions',
      readOnly: false,
    });

    const service = new ecs.FargateService(this, 'FunctionsService', {
      cluster: cluster,
      taskDefinition: taskDefinition,
      desiredCount: 1,
      serviceName: 'functions-service',
      securityGroups: [
        ec2.SecurityGroup.fromSecurityGroupId(this, 'ServiceSG', props.securityGroupId)
      ],
      vpcSubnets: {
        subnets: props.subnetIds.map((id, idx) => 
          ec2.Subnet.fromSubnetId(this, `ServiceSubnet${idx}`, id)
        ),
      },
      assignPublicIp: false,
    });

    fileSystem.connections.allowDefaultPortFrom(service.connections);
  }
}
