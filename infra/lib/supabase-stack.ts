import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

interface StackConfig {
  project: {
    name: string;
    environment: string;
    region: string;
    accountId: string;
  };
  infraStack: {
    vpc: {
      maxAzs: number;
      natGateways: number;
    };
    cluster: {
      name: string;
    };
    loadBalancer: {
      name: string;
    };
    studioLoadBalancer: {
      name: string;
    };
    certificate: {
      arn: string;
    };
    ecr: {
      repositories: {
        [key: string]: {
          name: string;
          uri: string;
        };
      };
    };
  };
  domain: {
    baseDomain: string;
    apiSubdomain: string;
  };
  secrets: {
    prefix: string;
  };
  rds: {
    engine: string;
    engineVersion: string;
    databaseName: string;
    port: number;
    serverlessV2MinCapacity: number;
    serverlessV2MaxCapacity: number;
    readers?: number;
  };
  workerRds: {
    engineVersion: string;
    databaseName: string;
    port: number;
    clusterIdentifier: string;
    serverlessV2MinCapacity: number;
    serverlessV2MaxCapacity: number;
    readers?: number;
  };
  redis?: {
    nodeType?: string;
    numCacheClusters?: number;
  };
  ecsTaskStack: {
    services: {
      functionsService: {
        cpu: number;
        memory: number;
        desiredCount: number;
      };
      tenantManager: {
        cpu: number;
        memory: number;
        desiredCount: number;
      };
      kong: {
        cpu: number;
        memory: number;
        desiredCount: number;
      };
      postgresMeta: {
        cpu: number;
        memory: number;
        desiredCount: number;
      };
      studio: {
        cpu: number;
        memory: number;
        desiredCount: number;
      };
      functionDeploy: {
        cpu: number;
        memory: number;
        desiredCount: number;
      };
      auth: {
        cpu: number;
        memory: number;
        desiredCount: number;
      };
    };
  };
  tags: {
    [key: string]: string;
  };
}

export class SupabaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 读取配置文件
    const configPath = path.join(__dirname, '..', '..', 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    const config: StackConfig = JSON.parse(configData);

    // Environment-aware defaults
    const isProduction = config.project.environment === 'production';
    const rdsReaders = config.rds.readers ?? (isProduction ? 1 : 0);
    const workerRdsReaders = config.workerRds.readers ?? (isProduction ? 1 : 0);
    const redisNodeType = config.redis?.nodeType ?? (isProduction ? 'cache.r6g.large' : 'cache.t3.micro');
    const redisNumCacheClusters = config.redis?.numCacheClusters ?? (isProduction ? 2 : 1);
    const rdsDeletionProtection = isProduction;
    const rdsRemovalPolicy = isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const backupRetentionDays = isProduction ? 30 : 7;

    // Get AWS Account ID and Region
    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // ========================================
    // 1. VPC
    // ========================================
    const vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: config.infraStack.vpc.maxAzs,
      natGateways: config.infraStack.vpc.natGateways,
    });

    // ========================================
    // 2. Lambda Security Group (for VPC Lambdas)
    // ========================================
    const lambdaSG = new ec2.SecurityGroup(this, 'LambdaSG', {
      vpc: vpc,
      description: 'Security group for Lambda functions in VPC',
      allowAllOutbound: true,
    });

    // ========================================
    // 3. RDS Security Group
    // ========================================
    const rdsSG = new ec2.SecurityGroup(this, 'RdsSG', {
      vpc: vpc,
      description: 'Security group for RDS PostgreSQL',
      allowAllOutbound: false,
    });
    rdsSG.addIngressRule(
      lambdaSG,
      ec2.Port.tcp(config.rds.port),
      'Allow Lambda to connect to RDS'
    );

    // ========================================
    // 4. RDS Subnet Group
    // ========================================
    const rdsSubnetGroup = new rds.SubnetGroup(this, 'RdsSubnetGroup', {
      vpc: vpc,
      description: 'Subnet group for RDS PostgreSQL',
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // ========================================
    // 5. Aurora PostgreSQL Cluster (Platform DB)
    // ========================================
    const rdsReaderInstances: rds.IClusterInstance[] = [];
    for (let i = 0; i < rdsReaders; i++) {
      rdsReaderInstances.push(rds.ClusterInstance.serverlessV2(`reader-${i}`));
    }

    const rdsCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_8,
      }),
      serverlessV2MinCapacity: config.rds.serverlessV2MinCapacity,
      serverlessV2MaxCapacity: config.rds.serverlessV2MaxCapacity,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      readers: rdsReaderInstances.length > 0 ? rdsReaderInstances : undefined,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [rdsSG],
      subnetGroup: rdsSubnetGroup,
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      defaultDatabaseName: config.rds.databaseName,
      removalPolicy: rdsRemovalPolicy,
      deletionProtection: rdsDeletionProtection,
      backup: { retention: cdk.Duration.days(backupRetentionDays) },
      storageEncrypted: true,
    });

    // ========================================
    // 5b. Worker Aurora Cluster (for tenant project databases)
    // ========================================
    const workerRdsSG = new ec2.SecurityGroup(this, 'WorkerRdsSG', {
      vpc: vpc,
      description: 'Security group for Worker Aurora PostgreSQL',
      allowAllOutbound: false,
    });
    workerRdsSG.addIngressRule(
      lambdaSG,
      ec2.Port.tcp(config.workerRds.port),
      'Allow Lambda (PostgREST) to connect to Worker Aurora'
    );

    const workerReaderInstances: rds.IClusterInstance[] = [];
    for (let i = 0; i < workerRdsReaders; i++) {
      workerReaderInstances.push(rds.ClusterInstance.serverlessV2(`reader-${i}`));
    }

    const workerRdsCluster = new rds.DatabaseCluster(this, 'WorkerAuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_8,
      }),
      serverlessV2MinCapacity: config.workerRds.serverlessV2MinCapacity,
      serverlessV2MaxCapacity: config.workerRds.serverlessV2MaxCapacity,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      readers: workerReaderInstances.length > 0 ? workerReaderInstances : undefined,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [workerRdsSG],
      subnetGroup: rdsSubnetGroup,
      clusterIdentifier: config.workerRds.clusterIdentifier,
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      defaultDatabaseName: config.workerRds.databaseName,
      removalPolicy: rdsRemovalPolicy,
      deletionProtection: rdsDeletionProtection,
      backup: { retention: cdk.Duration.days(backupRetentionDays) },
      storageEncrypted: true,
    });

    // ========================================
    // 5c. Platform Secrets (Secrets Manager)
    // ========================================
    const adminApiKeySecret = new secretsmanager.Secret(this, 'AdminApiKeySecret', {
      secretName: 'supabase/admin-api-key',
      description: 'Admin API key for tenant-manager and Studio authentication',
      generateSecretString: {
        passwordLength: 40,
        excludePunctuation: true,
      },
    });

    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: 'supabase/jwt-secret',
      description: 'JWT signing secret for tenant-manager',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    const encryptionKey = new secretsmanager.Secret(this, 'EncryptionKey', {
      secretName: 'supabase/encryption-key',
      description: 'AES-256 encryption key for API key secrets',
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    const pgMetaCryptoKey = new secretsmanager.Secret(this, 'PgMetaCryptoKey', {
      secretName: 'supabase/pg-meta-crypto-key',
      description: 'Crypto key for postgres-meta connection encryption',
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    // ========================================
    // 6. ECS Cluster with Service Discovery
    // ========================================
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: vpc,
      clusterName: config.infraStack.cluster.name,
      enableFargateCapacityProviders: true,
      defaultCloudMapNamespace: {
        name: 'supabase.local',
        type: servicediscovery.NamespaceType.DNS_PRIVATE,
      },
    });

    // ========================================
    // 3. CloudWatch Log Group
    // ========================================
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/ecs/supabase',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ========================================
    // 4. Security Groups
    // ========================================
    const albSG = new ec2.SecurityGroup(this, 'ALBSG', {
      vpc: vpc,
      description: 'Security group for ALB',
      allowAllOutbound: true,
    });
    albSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from internet'
    );
    albSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from internet'
    );

    const kongSG = new ec2.SecurityGroup(this, 'KongSG', {
      vpc: vpc,
      description: 'Security group for Kong Gateway',
      allowAllOutbound: true,
    });
    kongSG.addIngressRule(
      albSG,
      ec2.Port.tcp(8000),
      'Allow traffic from ALB to Kong proxy'
    );
    kongSG.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8000),
      'Allow traffic from VPC to Kong proxy'
    );

    const functionsSG = new ec2.SecurityGroup(this, 'FunctionsSG', {
      vpc: vpc,
      description: 'Security group for Functions Service',
      allowAllOutbound: true,
    });
    functionsSG.addIngressRule(
      kongSG,
      ec2.Port.tcp(8080),
      'Allow traffic from Kong to Functions Service'
    );

    const redisSG = new ec2.SecurityGroup(this, 'RedisSG', {
      vpc: vpc,
      description: 'Security group for Redis ElastiCache',
      allowAllOutbound: true,
    });
    redisSG.addIngressRule(
      kongSG,
      ec2.Port.tcp(6379),
      'Allow traffic from Kong to Redis'
    );

    // ========================================
    // Cross-service security group rules
    // ========================================
    rdsSG.addIngressRule(
      kongSG,
      ec2.Port.tcp(config.rds.port),
      'Allow Kong to connect to RDS for DB-backed mode'
    );
    // ========================================
    // Function Deploy Security Group
    // ========================================
    const functionDeploySG = new ec2.SecurityGroup(this, 'FunctionDeploySG', {
      vpc: vpc,
      description: 'Security group for function-deploy service',
      allowAllOutbound: true,
    });
    // Kong access to function-deploy is disabled - use Studio ALB instead

    // ========================================
    // Auth Service Security Group
    // ========================================
    const authSG = new ec2.SecurityGroup(this, 'AuthSG', {
      vpc: vpc,
      description: 'Security group for Auth (GoTrue) Service',
      allowAllOutbound: true,
    });
    authSG.addIngressRule(
      kongSG,
      ec2.Port.tcp(9999),
      'Allow Kong to access Auth Service'
    );

    // Auth → RDS (auth data storage)
    rdsSG.addIngressRule(
      authSG,
      ec2.Port.tcp(config.rds.port),
      'Allow Auth Service to connect to RDS'
    );

    // ========================================
    // EFS File System (shared: functions-service + function-deploy)
    // ========================================
    const functionsEfs = new efs.FileSystem(this, 'FunctionsEfs', {
      vpc: vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,  // 改为 Elastic 模式，自动扩展吞吐量
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Allow functions-service and function-deploy to access EFS (NFS port 2049)
    functionsEfs.connections.allowDefaultPortFrom(functionsSG, 'Allow functions-service to access EFS');
    functionsEfs.connections.allowDefaultPortFrom(functionDeploySG, 'Allow function-deploy to access EFS');

    // ========================================
    // 5. ElastiCache Redis (for Kong cache)
    // ========================================
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Redis ElastiCache',
      subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
      cacheSubnetGroupName: 'kong-redis-subnet-group',
    });

    const redisAuthToken = new secretsmanager.Secret(this, 'RedisAuthToken', {
      secretName: 'supabase/redis-auth-token',
      description: 'AUTH token for Redis ElastiCache',
      generateSecretString: {
        passwordLength: 40,
        excludePunctuation: true,
      },
    });

    const redisReplicationGroup = new elasticache.CfnReplicationGroup(this, 'RedisReplicationGroup', {
      replicationGroupDescription: `Kong cache (${config.project.environment})`,
      cacheNodeType: redisNodeType,
      engine: 'redis',
      engineVersion: '7.1',
      numCacheClusters: redisNumCacheClusters,
      cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
      securityGroupIds: [redisSG.securityGroupId],
      authToken: cdk.Fn.join('', ['{{resolve:secretsmanager:', redisAuthToken.secretName, '}}',]),
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      automaticFailoverEnabled: redisNumCacheClusters >= 2,
      multiAzEnabled: redisNumCacheClusters >= 2,
    });
    redisReplicationGroup.addDependency(redisSubnetGroup);

    // ========================================
    // 7. Application Load Balancer
    // ========================================
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: vpc,
      internetFacing: true,
      securityGroup: albSG,
      loadBalancerName: config.infraStack.loadBalancer.name,
    });

    // Set ALB idle timeout to 180 seconds for long-running Lambda operations
    alb.setAttribute('idle_timeout.timeout_seconds', '180');

    // ========================================
    // 8. Target Group
    // ========================================
    const kongTargetGroup = new elbv2.ApplicationTargetGroup(this, 'KongTargetGroup', {
      vpc: vpc,
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ========================================
    // 9. Import ACM Certificate
    // ========================================
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'Certificate',
      config.infraStack.certificate.arn
    );

    // ========================================
    // 10. HTTPS Listener
    // ========================================
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultTargetGroups: [kongTargetGroup],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED,
    });

    // ========================================
    // 11. HTTP Listener - Redirect to HTTPS
    // ========================================
    const httpListener = alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // ========================================
    // 12. Lambda Execution Role
    // ========================================

    // Permission Boundary: caps what any PostgREST Lambda function can do
    const lambdaPermissionBoundary = new iam.ManagedPolicy(this, 'LambdaPermissionBoundary', {
      managedPolicyName: 'postgrest-lambda-permission-boundary',
      description: 'Permission boundary for PostgREST Lambda functions',
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowVPCNetworkManagement',
          effect: iam.Effect.ALLOW,
          actions: [
            'ec2:CreateNetworkInterface',
            'ec2:DescribeNetworkInterfaces',
            'ec2:DeleteNetworkInterface',
            'ec2:AssignPrivateIpAddresses',
            'ec2:UnassignPrivateIpAddresses',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'AllowCloudWatchLogs',
          effect: iam.Effect.ALLOW,
          actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [`arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/postgrest-*`],
        }),
        new iam.PolicyStatement({
          sid: 'AllowSecretsManagerRead',
          effect: iam.Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [
            `arn:aws:secretsmanager:${region}:${accountId}:secret:postgrest/*`,
            rdsCluster.secret!.secretArn,
            workerRdsCluster.secret!.secretArn,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'AllowECRImagePull',
          effect: iam.Effect.ALLOW,
          actions: [
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
            'ecr:BatchCheckLayerAvailability',
            'ecr:GetAuthorizationToken',
          ],
          resources: ['*'],
        }),
      ],
    });

    const lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: `postgrest-lambda-execution-role-${cdk.Aws.REGION}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for PostgREST Lambda functions',
      permissionsBoundary: lambdaPermissionBoundary,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    lambdaExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'VPCNetworkInterfaceManagement',
        actions: [
          'ec2:CreateNetworkInterface',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DeleteNetworkInterface',
          'ec2:AssignPrivateIpAddresses',
          'ec2:UnassignPrivateIpAddresses',
        ],
        resources: ['*'],
        effect: iam.Effect.ALLOW,
      })
    );

    lambdaExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsAccess',
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [`arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/postgrest-*`],
        effect: iam.Effect.ALLOW,
      })
    );

    lambdaExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SecretsManagerAccess',
        actions: [
          'secretsmanager:GetSecretValue',
        ],
        resources: [
          `arn:aws:secretsmanager:${region}:${accountId}:secret:postgrest/*`,
          rdsCluster.secret!.secretArn,
          workerRdsCluster.secret!.secretArn,
        ],
        effect: iam.Effect.ALLOW,
      })
    );

    lambdaExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECRImagePullAccess',
        actions: [
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetAuthorizationToken',
        ],
        resources: ['*'],
        effect: iam.Effect.ALLOW,
      })
    );

    // ========================================
    // 13. Functions Service Task Definition (with EFS)
    // ========================================
    const functionsTask = new ecs.FargateTaskDefinition(this, 'FunctionsTask', {
      cpu: config.ecsTaskStack.services.functionsService.cpu,
      memoryLimitMiB: config.ecsTaskStack.services.functionsService.memory,
    });

    // Add ECR permissions to Execution Role
    functionsTask.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      })
    );

    // Secrets Manager permissions for encryption key
    functionsTask.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [encryptionKey.secretArn],
      })
    );

    // EFS IAM permissions
    functionsTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientRootAccess',
        ],
        resources: [functionsEfs.fileSystemArn],
      })
    );

    // EFS volume
    functionsTask.addVolume({
      name: 'functions-volume',
      efsVolumeConfiguration: {
        fileSystemId: functionsEfs.fileSystemId,
        transitEncryption: 'ENABLED',
        rootDirectory: '/',
        authorizationConfig: {
          iam: 'ENABLED',
        },
      },
    });

    const functionsImageUri = config.infraStack.ecr.repositories['functions-service']?.uri
      ? `${config.infraStack.ecr.repositories['functions-service'].uri}:latest`
      : `${accountId}.dkr.ecr.${region}.amazonaws.com/functions-service:latest`;

    const functionsContainer = functionsTask.addContainer('functions-service', {
      image: ecs.ContainerImage.fromRegistry(functionsImageUri),
      command: ['start', '--main-service', '/home/deno/functions/main', '-p', '8080'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'functions-service',
        logGroup: logGroup,
      }),
      portMappings: [{ containerPort: 8080 }],
      environment: {
        SUPABASE_SECRETS_PATH: '/home/deno/functions/.supabase/secrets',
      },
      secrets: {
        SUPABASE_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
      },
    });

    // Mount EFS
    functionsContainer.addMountPoints({
      sourceVolume: 'functions-volume',
      containerPath: '/home/deno/functions',
      readOnly: false,
    });

    const functionsService = new ecs.FargateService(this, 'FunctionsService', {
      cluster: cluster,
      taskDefinition: functionsTask,
      serviceName: 'functions-service',
      desiredCount: config.ecsTaskStack.services.functionsService.desiredCount,
      securityGroups: [functionsSG],
      circuitBreaker: { enable: false },
      cloudMapOptions: {
        name: 'functions-service',
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    // ========================================
    // Project Service Task Definition
    // ========================================
    // ========================================
    // Tenant Manager Service
    // ========================================
    const tenantManagerSG = new ec2.SecurityGroup(this, 'TenantManagerSG', {
      vpc: vpc,
      description: 'Security group for Tenant Manager Service',
      allowAllOutbound: true,
    });
    tenantManagerSG.addIngressRule(
      kongSG,
      ec2.Port.tcp(3001),
      'Allow traffic from Kong to Tenant Manager'
    );
    tenantManagerSG.addIngressRule(
      lambdaSG,
      ec2.Port.tcp(3001),
      'Allow Lambda to call Tenant Manager for PostgREST config'
    );
    tenantManagerSG.addIngressRule(
      functionDeploySG,
      ec2.Port.tcp(3001),
      'Allow function-deploy to access tenant-manager'
    );
    // Allow Tenant Manager to access function-deploy for Edge Functions cleanup
    functionDeploySG.addIngressRule(
      tenantManagerSG,
      ec2.Port.tcp(3000),
      'Allow tenant-manager to access function-deploy for cleanup'
    );
    // Allow Tenant Manager to access Kong Admin API
    kongSG.addIngressRule(
      tenantManagerSG,
      ec2.Port.tcp(8001),
      'Allow tenant-manager to access Kong Admin API'
    );
    // Allow Tenant Manager to connect to RDS
    rdsSG.addIngressRule(
      tenantManagerSG,
      ec2.Port.tcp(config.rds.port),
      'Allow tenant-manager to connect to RDS'
    );
    // Allow Tenant Manager to connect to Worker RDS for project provisioning
    workerRdsSG.addIngressRule(
      tenantManagerSG,
      ec2.Port.tcp(config.workerRds.port),
      'Allow tenant-manager to connect to Worker RDS'
    );

    const tenantManagerTask = new ecs.FargateTaskDefinition(this, 'TenantManagerTask', {
      cpu: config.ecsTaskStack.services.tenantManager.cpu,
      memoryLimitMiB: config.ecsTaskStack.services.tenantManager.memory,
    });

    tenantManagerTask.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      })
    );

    // Tenant Manager permissions: Secrets Manager, Lambda, IAM, ECR, EC2
    tenantManagerTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:DescribeSecret',
          'secretsmanager:GetSecretValue',
          'secretsmanager:DeleteSecret',
        ],
        resources: [
          `arn:aws:secretsmanager:${region}:${accountId}:secret:${config.secrets.prefix}*`,
          `arn:aws:secretsmanager:${region}:${accountId}:secret:supabase/*`,
          rdsCluster.secret!.secretArn,
          workerRdsCluster.secret!.secretArn,
          adminApiKeySecret.secretArn,
          jwtSecret.secretArn,
          encryptionKey.secretArn,
        ],
      })
    );

    tenantManagerTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'lambda:CreateFunction',
          'lambda:GetFunction',
          'lambda:DeleteFunction',
          'lambda:CreateFunctionUrlConfig',
          'lambda:GetFunctionUrlConfig',
          'lambda:UpdateFunctionConfiguration',
          'lambda:PublishVersion',
        ],
        resources: [`arn:aws:lambda:${region}:${accountId}:function:postgrest-*`],
      })
    );

    tenantManagerTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [lambdaExecutionRole.roleArn],
      })
    );

    tenantManagerTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeSubnets',
          'ec2:DescribeVpcs',
        ],
        resources: ['*'],
      })
    );

    const tenantManagerImageUri = config.infraStack.ecr.repositories['tenant-manager']?.uri
      ? `${config.infraStack.ecr.repositories['tenant-manager'].uri}:latest`
      : `${accountId}.dkr.ecr.${region}.amazonaws.com/tenant-manager:latest`;

    tenantManagerTask.addContainer('tenant-manager', {
      image: ecs.ContainerImage.fromRegistry(tenantManagerImageUri),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'tenant-manager',
        logGroup: logGroup,
      }),
      portMappings: [{ containerPort: 3001 }],
      environment: {
        // Service config
        PORT: '3001',
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        // Database (management pool - _supabase schema)
        POSTGRES_HOST: rdsCluster.clusterEndpoint.hostname,
        POSTGRES_PORT: String(config.rds.port),
        POSTGRES_DB: 'postgres',
        POSTGRES_USER_READ_WRITE: 'postgres',
        // AWS
        AWS_REGION: region,
        AWS_SECRETS_PREFIX: 'supabase',
        // Lambda creation
        POSTGREST_ECR_IMAGE_URI: `${accountId}.dkr.ecr.${region}.amazonaws.com/postgrest-lambda:latest`,
        LAMBDA_ROLE_ARN: lambdaExecutionRole.roleArn,
        VPC_SUBNET_IDS: vpc.privateSubnets.map(s => s.subnetId).join(','),
        VPC_SECURITY_GROUP_IDS: lambdaSG.securityGroupId,
        RDS_SECRET_ARN: rdsCluster.secret!.secretArn,
        // Kong Admin
        KONG_ADMIN_URL: 'http://kong-gateway.supabase.local:8001',
        // Platform DB (supabase_platform)
        PLATFORM_DB_HOST: rdsCluster.clusterEndpoint.hostname,
        PLATFORM_DB_PORT: String(config.rds.port),
        PLATFORM_DB_NAME: 'supabase_platform',
        PLATFORM_DB_USER: 'postgres',
        // External services
        GOTRUE_URL: 'http://auth:9999',
        GOTRUE_MULTI_TENANT: 'false',
        REALTIME_URL: 'http://realtime:4000',
        SUPAVISOR_URL: 'http://supavisor:4000',
        RDS_CA_CERT_PATH: '/etc/ssl/certs/rds-global-bundle.pem',
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(rdsCluster.secret!, 'password'),
        PLATFORM_DB_PASSWORD: ecs.Secret.fromSecretsManager(rdsCluster.secret!, 'password'),
        ADMIN_API_KEY: ecs.Secret.fromSecretsManager(adminApiKeySecret),
        JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
        ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:3001/health/live || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const tenantManagerService = new ecs.FargateService(this, 'TenantManagerService', {
      cluster: cluster,
      taskDefinition: tenantManagerTask,
      serviceName: 'tenant-manager',
      desiredCount: config.ecsTaskStack.services.tenantManager.desiredCount,
      securityGroups: [tenantManagerSG],
      circuitBreaker: { enable: false },
      cloudMapOptions: {
        name: 'tenant-manager',
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    // ========================================
    // postgres-meta Service
    // ========================================
    const postgresMetaSG = new ec2.SecurityGroup(this, 'PostgresMetaSG', {
      vpc: vpc,
      description: 'Security group for postgres-meta Service',
      allowAllOutbound: true,
    });

    // postgres-meta needs to connect to Worker RDS for tenant databases
    workerRdsSG.addIngressRule(
      postgresMetaSG,
      ec2.Port.tcp(config.workerRds.port),
      'Allow postgres-meta to connect to Worker RDS'
    );

    // Auth (GoTrue) multi-tenant mode connects to per-tenant databases on Worker RDS
    workerRdsSG.addIngressRule(
      authSG,
      ec2.Port.tcp(config.workerRds.port),
      'Allow Auth Service to connect to Worker RDS'
    );

    // postgres-meta may also need management RDS access
    rdsSG.addIngressRule(
      postgresMetaSG,
      ec2.Port.tcp(config.rds.port),
      'Allow postgres-meta to connect to management RDS'
    );

    const postgresMetaTask = new ecs.FargateTaskDefinition(this, 'PostgresMetaTask', {
      cpu: config.ecsTaskStack.services.postgresMeta.cpu,
      memoryLimitMiB: config.ecsTaskStack.services.postgresMeta.memory,
    });

    postgresMetaTask.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      })
    );

    const postgresMetaImageUri = config.infraStack.ecr.repositories['postgres-meta']?.uri
      ? `${config.infraStack.ecr.repositories['postgres-meta'].uri}:latest`
      : `${accountId}.dkr.ecr.${region}.amazonaws.com/postgres-meta:latest`;

    postgresMetaTask.addContainer('postgres-meta', {
      image: ecs.ContainerImage.fromRegistry(postgresMetaImageUri),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'postgres-meta',
        logGroup: logGroup,
      }),
      portMappings: [{ containerPort: 8080 }],
      environment: {
        PG_META_PORT: '8080',
        PG_META_DB_SSL_MODE: 'verify-ca',
        PG_META_DB_SSL_ROOT_CERT: '/etc/ssl/certs/rds-global-bundle.pem',
      },
      secrets: {
        CRYPTO_KEY: ecs.Secret.fromSecretsManager(pgMetaCryptoKey),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://localhost:8080/health\').then((r) => {if (r.status !== 200) throw new Error(r.status)})"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(15),
      },
    });

    const postgresMetaService = new ecs.FargateService(this, 'PostgresMetaService', {
      cluster: cluster,
      taskDefinition: postgresMetaTask,
      serviceName: 'postgres-meta',
      desiredCount: config.ecsTaskStack.services.postgresMeta.desiredCount,
      securityGroups: [postgresMetaSG],
      circuitBreaker: { enable: false },
      cloudMapOptions: {
        name: 'postgres-meta',
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    // ========================================
    // Function Deploy Service (Edge Functions Management)
    // ========================================
    const functionDeployTask = new ecs.FargateTaskDefinition(this, 'FunctionDeployTask', {
      cpu: config.ecsTaskStack.services.functionDeploy.cpu,
      memoryLimitMiB: config.ecsTaskStack.services.functionDeploy.memory,
    });

    functionDeployTask.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      })
    );

    // EFS IAM permissions
    functionDeployTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientRootAccess',
        ],
        resources: [functionsEfs.fileSystemArn],
      })
    );

    // Secrets Manager permissions for RDS credentials and encryption key
    functionDeployTask.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          rdsCluster.secret!.secretArn,
          adminApiKeySecret.secretArn,
          encryptionKey.secretArn,
        ],
      })
    );

    // EFS volume
    functionDeployTask.addVolume({
      name: 'functions-volume',
      efsVolumeConfiguration: {
        fileSystemId: functionsEfs.fileSystemId,
        rootDirectory: '/',
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          iam: 'ENABLED',
        },
      },
    });

    const functionDeployImageUri = config.infraStack.ecr.repositories['function-deploy']?.uri
      ? `${config.infraStack.ecr.repositories['function-deploy'].uri}:latest`
      : `${accountId}.dkr.ecr.${region}.amazonaws.com/function-deploy:latest`;

    const functionDeployContainer = functionDeployTask.addContainer('function-deploy', {
      image: ecs.ContainerImage.fromRegistry(functionDeployImageUri),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'function-deploy',
        logGroup: logGroup,
      }),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        POSTGRES_HOST: rdsCluster.clusterEndpoint.hostname,
        POSTGRES_PORT: String(config.rds.port),
        POSTGRES_USER: 'postgres',
        POSTGRES_DB: 'postgres',
        FUNCTIONS_PATH: '/home/deno/functions',
        EDGE_FUNCTIONS_LOCAL_PATH: '/home/deno/functions',
        AWS_REGION: region,
        STUDIO_NO_AUTH_MODE: 'true',
        EDGE_FUNCTIONS_STORAGE_BACKEND: 'database',
        EDGE_FUNCTIONS_CODE_STORAGE: 'local',
        TENANT_MANAGER_URL: 'http://tenant-manager.supabase.local:3001',
        RDS_CA_CERT_PATH: '/etc/ssl/certs/rds-global-bundle.pem',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/rds-global-bundle.pem',
        SUPABASE_SECRETS_PATH: '/home/deno/functions/.supabase/secrets',
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(rdsCluster.secret!, 'password'),
        TENANT_MANAGER_API_KEY: ecs.Secret.fromSecretsManager(adminApiKeySecret),
        SUPABASE_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
      },
      entryPoint: ['sh', '-c'],
      command: ['export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}?sslmode=verify-ca" && export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem && node apps/studio/server.js'],
    });

    // Mount EFS
    functionDeployContainer.addMountPoints({
      sourceVolume: 'functions-volume',
      containerPath: '/home/deno/functions',
      readOnly: false,
    });

    // Allow function-deploy to access RDS
    rdsSG.addIngressRule(
      functionDeploySG,
      ec2.Port.tcp(config.rds.port),
      'Allow function-deploy to access RDS'
    );

    const functionDeployService = new ecs.FargateService(this, 'FunctionDeployService', {
      cluster: cluster,
      taskDefinition: functionDeployTask,
      serviceName: 'function-deploy',
      desiredCount: config.ecsTaskStack.services.functionDeploy.desiredCount,
      securityGroups: [functionDeploySG],
      circuitBreaker: { enable: false },
      cloudMapOptions: {
        name: 'function-deploy',
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    // ========================================
    // Auth (GoTrue) Service
    // ========================================
    const authTask = new ecs.FargateTaskDefinition(this, 'AuthTask', {
      cpu: config.ecsTaskStack.services.auth.cpu,
      memoryLimitMiB: config.ecsTaskStack.services.auth.memory,
    });

    authTask.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      })
    );

    // Auth needs to read RDS secret, JWT secret, and admin API key secret
    authTask.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          rdsCluster.secret!.secretArn,
          jwtSecret.secretArn,
          adminApiKeySecret.secretArn,
        ],
      })
    );

    const authImageUri = config.infraStack.ecr.repositories['auth-service']?.uri
      ? `${config.infraStack.ecr.repositories['auth-service'].uri}:latest`
      : `${accountId}.dkr.ecr.${region}.amazonaws.com/auth-service:latest`;

    authTask.addContainer('auth-service', {
      image: ecs.ContainerImage.fromRegistry(authImageUri),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'auth-service',
        logGroup: logGroup,
      }),
      portMappings: [{ containerPort: 9999 }],
      environment: {
        GOTRUE_API_HOST: '0.0.0.0',
        PORT: '9999',
        API_EXTERNAL_URL: `https://${config.domain.baseDomain}`,
        GOTRUE_SITE_URL: `https://${config.domain.baseDomain}`,
        GOTRUE_MAILER_AUTOCONFIRM: 'true',
        GOTRUE_DISABLE_SIGNUP: 'false',
        GOTRUE_MULTI_TENANT_TENANT_MANAGER_URL: 'http://tenant-manager.supabase.local:3001',
        GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
      },
      secrets: {
        GOTRUE_JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
        GOTRUE_MULTI_TENANT_TENANT_MANAGER_KEY: ecs.Secret.fromSecretsManager(adminApiKeySecret),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget --spider -q http://localhost:9999/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const authService = new ecs.FargateService(this, 'AuthService', {
      cluster: cluster,
      taskDefinition: authTask,
      serviceName: 'auth-service',
      desiredCount: config.ecsTaskStack.services.auth.desiredCount,
      securityGroups: [authSG],
      circuitBreaker: { enable: false },
      cloudMapOptions: {
        name: 'auth-service',
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    // ========================================
    // Studio Service
    // ========================================
    const studioSG = new ec2.SecurityGroup(this, 'StudioSG', {
      vpc: vpc,
      description: 'Security group for Supabase Studio',
      allowAllOutbound: true,
    });

    // Studio needs to access postgres-meta
    postgresMetaSG.addIngressRule(
      studioSG,
      ec2.Port.tcp(8080),
      'Allow Studio to access postgres-meta'
    );

    // Studio needs to access tenant-manager
    tenantManagerSG.addIngressRule(
      studioSG,
      ec2.Port.tcp(3001),
      'Allow Studio to access tenant-manager'
    );

    const studioAlbSG = new ec2.SecurityGroup(this, 'StudioALBSG', {
      vpc: vpc,
      description: 'Security group for Studio ALB',
      allowAllOutbound: true,
    });
    studioAlbSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from internet'
    );
    studioAlbSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from internet'
    );

    // Allow Studio ALB to reach Studio on port 3000
    studioSG.addIngressRule(
      studioAlbSG,
      ec2.Port.tcp(3000),
      'Allow traffic from Studio ALB'
    );

    // Allow Studio ALB to reach Tenant Manager on port 3001 (path-based routing)
    tenantManagerSG.addIngressRule(
      studioAlbSG,
      ec2.Port.tcp(3001),
      'Allow traffic from Studio ALB to Tenant Manager'
    );

    // Allow Studio ALB to reach function-deploy on port 3000 (path-based routing for /api/v1/projects/*)
    functionDeploySG.addIngressRule(
      studioAlbSG,
      ec2.Port.tcp(3000),
      'Allow traffic from Studio ALB to function-deploy'
    );

    // Auth (GoTrue) multi-tenant mode needs to fetch tenant config from tenant-manager
    tenantManagerSG.addIngressRule(
      authSG,
      ec2.Port.tcp(3001),
      'Allow Auth Service to access tenant-manager for tenant config'
    );

    const studioTask = new ecs.FargateTaskDefinition(this, 'StudioTask', {
      cpu: config.ecsTaskStack.services.studio.cpu,
      memoryLimitMiB: config.ecsTaskStack.services.studio.memory,
    });

    studioTask.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      })
    );

    const studioImageUri = config.infraStack.ecr.repositories['studio']?.uri
      ? `${config.infraStack.ecr.repositories['studio'].uri}:latest`
      : `${accountId}.dkr.ecr.${region}.amazonaws.com/studio:latest`;

    studioTask.addContainer('studio', {
      image: ecs.ContainerImage.fromRegistry(studioImageUri),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'studio',
        logGroup: logGroup,
      }),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        NEXT_PUBLIC_IS_PLATFORM: 'false',
        STUDIO_PG_META_URL: 'http://postgres-meta.supabase.local:8080',
        TENANT_MANAGER_URL: 'http://tenant-manager.supabase.local:3001',
        DEFAULT_PROJECT_NAME: 'Default Project',
        DEFAULT_ORGANIZATION_NAME: 'Default Organization',
        SUPABASE_URL: `https://${config.domain.apiSubdomain}.${config.domain.baseDomain}`,
        NEXT_PUBLIC_SITE_URL: `https://studio.${config.domain.baseDomain}`,
        PORT: '3000',
        NODE_ENV: 'production',
        HOSTNAME: '0.0.0.0',
      },
      secrets: {
        PG_META_CRYPTO_KEY: ecs.Secret.fromSecretsManager(pgMetaCryptoKey),
        TENANT_MANAGER_API_KEY: ecs.Secret.fromSecretsManager(adminApiKeySecret),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://localhost:3000/api/platform/profile\').then((r) => {if (r.status !== 200) throw new Error(r.status)})"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    const studioService = new ecs.FargateService(this, 'StudioService', {
      cluster: cluster,
      taskDefinition: studioTask,
      serviceName: 'studio',
      desiredCount: config.ecsTaskStack.services.studio.desiredCount,
      securityGroups: [studioSG],
      circuitBreaker: { enable: false },
      cloudMapOptions: {
        name: 'studio',
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    // ========================================
    // Studio Dedicated ALB
    // ========================================
    const studioAlb = new elbv2.ApplicationLoadBalancer(this, 'StudioALB', {
      vpc: vpc,
      internetFacing: true,
      securityGroup: studioAlbSG,
      loadBalancerName: config.infraStack.studioLoadBalancer.name,
    });

    // Set Studio ALB idle timeout to 400s (routes /admin/v1/* to tenant-manager for project creation)
    studioAlb.setAttribute('idle_timeout.timeout_seconds', '400');

    const studioTargetGroup = new elbv2.ApplicationTargetGroup(this, 'StudioTargetGroup', {
      vpc: vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/api/platform/profile',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    const studioHttpsListener = studioAlb.addListener('StudioHttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultTargetGroups: [studioTargetGroup],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED,
    });

    studioAlb.addListener('StudioHttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    studioService.attachToApplicationTargetGroup(studioTargetGroup);

    // ── Path-based routing: /admin/v1/* and /health/* → Tenant Manager ──
    const studioAlbTmTargetGroup = new elbv2.ApplicationTargetGroup(this, 'StudioAlbTmTargetGroup', {
      vpc: vpc,
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health/live',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    tenantManagerService.attachToApplicationTargetGroup(studioAlbTmTargetGroup);

    studioHttpsListener.addAction('StudioAlbTmRouting', {
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/admin/v1/*', '/health/*']),
      ],
      action: elbv2.ListenerAction.forward([studioAlbTmTargetGroup]),
    });

    // ── Path-based routing: /api/v1/projects/*, /v1/projects/* → function-deploy ──
    const functionDeployTargetGroup = new elbv2.ApplicationTargetGroup(this, 'FunctionDeployTargetGroup', {
      vpc: vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/api/platform/profile',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    functionDeployService.attachToApplicationTargetGroup(functionDeployTargetGroup);

    studioHttpsListener.addAction('FunctionDeployRouting', {
      priority: 5,
      conditions: [
        elbv2.ListenerCondition.pathPatterns([
          '/api/v1/projects/*/functions*',
          '/v1/projects/*/functions*'
        ]),
      ],
      action: elbv2.ListenerAction.forward([functionDeployTargetGroup]),
    });

    studioHttpsListener.addAction('SecretsRouting', {
      priority: 6,
      conditions: [
        elbv2.ListenerCondition.pathPatterns([
          '/api/v1/projects/*/secrets*',
          '/v1/projects/*/secrets*'
        ]),
      ],
      action: elbv2.ListenerAction.forward([functionDeployTargetGroup]),
    });

    // ========================================
    // 15. Kong Gateway Task Definition
    // ========================================
    const kongTask = new ecs.FargateTaskDefinition(this, 'KongTask', {
      cpu: config.ecsTaskStack.services.kong.cpu,
      memoryLimitMiB: config.ecsTaskStack.services.kong.memory,
    });

    // Add ECR permissions to Execution Role
    kongTask.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      })
    );

    kongTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl'],
        resources: [`arn:aws:lambda:${region}:${accountId}:function:postgrest-*`],
      })
    );

    kongTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [rdsCluster.secret!.secretArn],
      })
    );

    const kongImageUri = config.infraStack.ecr.repositories['kong-configured']?.uri
      ? `${config.infraStack.ecr.repositories['kong-configured'].uri}:latest`
      : `${accountId}.dkr.ecr.${region}.amazonaws.com/kong-configured:latest`;

    kongTask.addContainer('kong', {
      image: ecs.ContainerImage.fromRegistry(kongImageUri),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'kong',
        logGroup: logGroup,
      }),
      portMappings: [
        { containerPort: 8000 },
        { containerPort: 8001 },
      ],
      environment: {
        KONG_DATABASE: 'postgres',
        KONG_PG_HOST: rdsCluster.clusterEndpoint.hostname,
        KONG_PG_PORT: String(config.rds.port),
        KONG_PG_USER: 'postgres',
        KONG_PG_DATABASE: 'postgres',
        KONG_PG_SSL: 'on',
        KONG_PG_SSL_VERIFY: 'on',
        KONG_LUA_SSL_TRUSTED_CERTIFICATE: '/etc/ssl/certs/rds-global-bundle.pem,system',
        KONG_PG_POOL_SIZE: '10',
        KONG_PG_KEEPALIVE_TIMEOUT: '300000',
        KONG_PG_BACKLOG: '20',
        KONG_DB_CACHE_TTL: '300',
        KONG_DB_UPDATE_FREQUENCY: '30',
        KONG_DB_CACHE_WARMUP_ENTITIES: 'services,routes,plugins,consumers,acls,keyauth_credentials',
        KONG_PROXY_ACCESS_LOG: '/dev/stdout',
        KONG_ADMIN_ACCESS_LOG: '/dev/stdout',
        KONG_PROXY_ERROR_LOG: '/dev/stderr',
        KONG_ADMIN_ERROR_LOG: '/dev/stderr',
        KONG_ADMIN_LISTEN: '0.0.0.0:8001',
        KONG_BASE_DOMAIN: config.domain.baseDomain,
        KONG_API_SUBDOMAIN: config.domain.apiSubdomain,
        KONG_REDIS_HOST: redisReplicationGroup.attrPrimaryEndPointAddress,
        KONG_REDIS_PORT: redisReplicationGroup.attrPrimaryEndPointPort,
        KONG_REDIS_SSL: 'true',
        KONG_FUNCTIONS_SERVICE_URL: 'http://functions-service.supabase.local:8080',
        KONG_TENANT_MANAGER_URL: 'http://tenant-manager.supabase.local:3001',
        KONG_AUTH_SERVICE_URL: 'http://auth-service.supabase.local:9999',
        KONG_AWS_REGION: region,
        KONG_UNTRUSTED_LUA: 'on',
        CACHE_BUST: `v${Date.now()}`,
      },
      secrets: {
        KONG_PG_PASSWORD: ecs.Secret.fromSecretsManager(rdsCluster.secret!, 'password'),
        KONG_REDIS_PASSWORD: ecs.Secret.fromSecretsManager(redisAuthToken),
      },
    });

    const kongService = new ecs.FargateService(this, 'KongService', {
      cluster: cluster,
      taskDefinition: kongTask,
      serviceName: 'kong-gateway',
      desiredCount: config.ecsTaskStack.services.kong.desiredCount,
      securityGroups: [kongSG],
      circuitBreaker: { enable: false },
      cloudMapOptions: {
        name: 'kong-gateway',
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    kongService.attachToApplicationTargetGroup(kongTargetGroup);

    // ========================================
    // ECS Auto Scaling (all services)
    // ========================================
    const scalingConfig = {
      minCapacity: 2,
      maxCapacity: 20,
    };
    const cpuScalingPolicy = {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    };

    const kongScaling = kongService.autoScaleTaskCount(scalingConfig);
    kongScaling.scaleOnCpuUtilization('KongCpuScaling', cpuScalingPolicy);

    const tmScaling = tenantManagerService.autoScaleTaskCount(scalingConfig);
    tmScaling.scaleOnCpuUtilization('TmCpuScaling', cpuScalingPolicy);

    const studioScaling = studioService.autoScaleTaskCount(scalingConfig);
    studioScaling.scaleOnCpuUtilization('StudioCpuScaling', cpuScalingPolicy);

    const postgresMetaScaling = postgresMetaService.autoScaleTaskCount(scalingConfig);
    postgresMetaScaling.scaleOnCpuUtilization('PgMetaCpuScaling', cpuScalingPolicy);

    const functionsScaling = functionsService.autoScaleTaskCount(scalingConfig);
    functionsScaling.scaleOnCpuUtilization('FunctionsCpuScaling', cpuScalingPolicy);

    const functionDeployScaling = functionDeployService.autoScaleTaskCount(scalingConfig);
    functionDeployScaling.scaleOnCpuUtilization('FnDeployCpuScaling', cpuScalingPolicy);

    const authScaling = authService.autoScaleTaskCount(scalingConfig);
    authScaling.scaleOnCpuUtilization('AuthCpuScaling', cpuScalingPolicy);

    // ========================================
    // CloudWatch Alarms
    // ========================================
    const opsTopic = new sns.Topic(this, 'OpsAlarmTopic', {
      topicName: 'supabase-ops-alarms',
      displayName: 'Supabase Operations Alarms',
    });

    // RDS CPU > 80%
    new cloudwatch.Alarm(this, 'RdsCpuAlarm', {
      alarmName: 'supabase-rds-cpu-high',
      metric: rdsCluster.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(new cw_actions.SnsAction(opsTopic));

    new cloudwatch.Alarm(this, 'WorkerRdsCpuAlarm', {
      alarmName: 'supabase-worker-rds-cpu-high',
      metric: workerRdsCluster.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(new cw_actions.SnsAction(opsTopic));

    // ALB 5xx > 1%
    const alb5xxMetric = new cloudwatch.MathExpression({
      expression: 'IF(m1+m2 > 0, m1/(m1+m2)*100, 0)',
      usingMetrics: {
        m1: alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: cdk.Duration.minutes(5) }),
        m2: alb.metrics.requestCount({ period: cdk.Duration.minutes(5) }),
      },
      period: cdk.Duration.minutes(5),
    });
    new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmName: 'supabase-alb-5xx-rate-high',
      metric: alb5xxMetric,
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cw_actions.SnsAction(opsTopic));

    new cdk.CfnOutput(this, 'OpsAlarmTopicArn', {
      value: opsTopic.topicArn,
      description: 'SNS Topic ARN for operations alarms',
    });

    // ========================================
    // WAF Protection
    // ========================================
    const wafAcl = new wafv2.CfnWebACL(this, 'WafWebAcl', {
      name: 'supabase-waf',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'supabase-waf',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { count: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'common-rules',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesSQLiRuleSet',
          priority: 2,
          overrideAction: { count: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesSQLiRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'sqli-rules',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimitRule',
          priority: 3,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'rate-limit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate WAF with all 3 ALBs
    new wafv2.CfnWebACLAssociation(this, 'WafAlbAssociation', {
      resourceArn: alb.loadBalancerArn,
      webAclArn: wafAcl.attrArn,
    });
    new wafv2.CfnWebACLAssociation(this, 'WafStudioAlbAssociation', {
      resourceArn: studioAlb.loadBalancerArn,
      webAclArn: wafAcl.attrArn,
    });

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, 'VPCId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster Name',
    });

    new cdk.CfnOutput(this, 'ALBDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'ALB DNS Name',
      exportName: 'SupabaseALBDnsName',
    });

    new cdk.CfnOutput(this, 'HttpsUrl', {
      value: `https://${alb.loadBalancerDnsName}`,
      description: 'HTTPS URL for ALB',
    });

    new cdk.CfnOutput(this, 'LambdaExecutionRoleArn', {
      value: lambdaExecutionRole.roleArn,
      description: 'Lambda Execution Role ARN',
      exportName: 'LambdaExecutionRoleArn',
    });

    new cdk.CfnOutput(this, 'FunctionsServiceName', {
      value: functionsService.serviceName,
      description: 'Functions Service Name',
    });

    new cdk.CfnOutput(this, 'KongServiceName', {
      value: kongService.serviceName,
      description: 'Kong Gateway Service Name',
    });

    new cdk.CfnOutput(this, 'TenantManagerServiceName', {
      value: tenantManagerService.serviceName,
      description: 'Tenant Manager Service Name',
    });

    new cdk.CfnOutput(this, 'StudioALBDnsName', {
      value: studioAlb.loadBalancerDnsName,
      description: 'Studio ALB DNS Name',
      exportName: 'SupabaseStudioALBDnsName',
    });

    new cdk.CfnOutput(this, 'StudioServiceName', {
      value: studioService.serviceName,
      description: 'Studio Service Name',
    });

    new cdk.CfnOutput(this, 'PostgresMetaServiceName', {
      value: postgresMetaService.serviceName,
      description: 'postgres-meta Service Name',
    });

    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: redisReplicationGroup.attrPrimaryEndPointAddress,
      description: 'Redis ElastiCache Primary Endpoint',
    });

    new cdk.CfnOutput(this, 'RdsEndpoint', {
      value: rdsCluster.clusterEndpoint.hostname,
      description: 'RDS PostgreSQL Endpoint',
      exportName: 'SupabaseRdsEndpoint',
    });

    new cdk.CfnOutput(this, 'RdsSecretArn', {
      value: rdsCluster.secret!.secretArn,
      description: 'RDS Credentials Secret ARN',
      exportName: 'SupabaseRdsSecretArn',
    });

    new cdk.CfnOutput(this, 'LambdaSgId', {
      value: lambdaSG.securityGroupId,
      description: 'Lambda Security Group ID',
      exportName: 'SupabaseLambdaSgId',
    });

    new cdk.CfnOutput(this, 'VpcSubnetIds', {
      value: vpc.privateSubnets.map(s => s.subnetId).join(','),
      description: 'VPC Private Subnet IDs',
      exportName: 'SupabaseVpcSubnetIds',
    });

    new cdk.CfnOutput(this, 'WorkerRdsEndpoint', {
      value: workerRdsCluster.clusterEndpoint.hostname,
      description: 'Worker RDS PostgreSQL Endpoint',
      exportName: 'SupabaseWorkerRdsEndpoint',
    });

    new cdk.CfnOutput(this, 'WorkerRdsSecretArn', {
      value: workerRdsCluster.secret!.secretArn,
      description: 'Worker RDS Credentials Secret ARN',
      exportName: 'SupabaseWorkerRdsSecretArn',
    });

    new cdk.CfnOutput(this, 'WorkerRdsSgId', {
      value: workerRdsSG.securityGroupId,
      description: 'Worker RDS Security Group ID',
      exportName: 'SupabaseWorkerRdsSgId',
    });

    new cdk.CfnOutput(this, 'AdminApiKeySecretArn', {
      value: adminApiKeySecret.secretArn,
      description: 'Admin API Key Secret ARN',
    });

    new cdk.CfnOutput(this, 'FunctionDeployServiceName', {
      value: functionDeployService.serviceName,
      description: 'Function Deploy Service Name',
    });

    new cdk.CfnOutput(this, 'AuthServiceName', {
      value: authService.serviceName,
      description: 'Auth (GoTrue) Service Name',
    });

    new cdk.CfnOutput(this, 'EfsFileSystemId', {
      value: functionsEfs.fileSystemId,
      description: 'EFS File System ID for Edge Functions',
    });

    // Apply tags from config
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });
  }
}
