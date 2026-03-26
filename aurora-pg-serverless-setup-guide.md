# Aurora PostgreSQL Serverless v2 Manual Setup Guide

## Environment Configuration Comparison

| Configuration | Test | Production |
|--------------|------|------------|
| Serverless v2 ACU Range | MinCapacity=0.5, MaxCapacity=4 | MinCapacity=2, MaxCapacity=16 |
| Reader Replica | Not required | Required (at least 1) |
| Deletion Protection | Disabled | Enabled |
| Backup Retention | 7 days | 30 days |
| Cluster Identifier Suffix | `-test` | `-prod` |

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Step 1: Configure Environment Variables](#2-step-1-configure-environment-variables)
3. [Step 2: Query/Prepare Parameter Groups](#3-step-2-queryprepare-parameter-groups)
4. [Step 3: Query/Prepare Security Groups](#4-step-3-queryprepare-security-groups)
5. [Step 4: Create Aurora Serverless v2 Cluster (IO/Optimized)](#5-step-4-create-aurora-serverless-v2-cluster-iooptimized)
6. [Step 5: (Production) Create Reader Replica](#6-step-5-production-create-reader-replica)
7. [Step 6: Store Credentials in Secrets Manager](#7-step-6-store-credentials-in-secrets-manager)
8. [Step 7: Register Database with Supabase Tenant Manager via API](#8-step-7-register-database-with-supabase-tenant-manager-via-api)
9. [Step 8: RDS Instance Management Endpoint Demo](#9-step-8-rds-instance-management-endpoint-demo)

---

## 1. Prerequisites

- AWS CLI v2 installed and configured with `rds:*`, `ec2:*SecurityGroup*`, `secretsmanager:*` permissions
- Existing Supabase platform deployed (VPC, ECS, Tenant Manager running)
- Tenant Manager Admin API Key available (stored in Secrets Manager at `supabase/admin-api-key`)
- `jq` CLI tool installed

---

## 2. Step 1: Configure Environment Variables

```bash
# ========================================
# Base Configuration - Modify for your environment
# ========================================
export REGION="us-east-1"
export VPC_ID="vpc-xxxxxxxx"
export SUBNET_GROUP="supabase-rds-subnet-group"       # Existing RDS subnet group name

# ========================================
# Environment Type: prod or test
# ========================================
export ENV_TYPE="prod"   # Change to "test" for test environment

# ========================================
# New Cluster Configuration (auto-set based on environment)
# ========================================
export CLUSTER_ID="supabase-new-worker-cluster-${ENV_TYPE}"
export INSTANCE_ID="${CLUSTER_ID}-writer"
export DB_MASTER_USER="postgres"
export DB_PASSWORD="$(openssl rand -base64 32)"       # Auto-generate strong password, or set manually
export DB_PORT=5432
export ENGINE_VERSION="16.8"

# Environment-specific configuration
if [ "$ENV_TYPE" = "prod" ]; then
  export MIN_ACU=2
  export MAX_ACU=16
  export READER_COUNT=1          # Number of readers for production
  export DELETION_PROTECTION=true
  export BACKUP_RETENTION=30
else
  export MIN_ACU=0.5
  export MAX_ACU=4
  export READER_COUNT=0          # No readers for test environment
  export DELETION_PROTECTION=false
  export BACKUP_RETENTION=7
fi

echo "Environment: $ENV_TYPE"
echo "Cluster: $CLUSTER_ID"
echo "ACU Range: $MIN_ACU - $MAX_ACU"
echo "Reader Count: $READER_COUNT"
echo "Password generated: $DB_PASSWORD"
echo "Please save this password securely — it will be needed in subsequent steps"
```

> Helper commands to query existing resource IDs:

```bash
# Query VPC
aws ec2 describe-vpcs --filters "Name=tag:Name,Values=*supabase*" \
  --query "Vpcs[0].VpcId" --output text --region $REGION

# Query subnet groups
aws rds describe-db-subnet-groups \
  --query "DBSubnetGroups[*].{Name:DBSubnetGroupName,VPC:VpcId}" \
  --output table --region $REGION

# Query all security groups
aws ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query "SecurityGroups[*].{ID:GroupId,Name:GroupName}" \
  --output table --region $REGION
```

---

## 3. Step 2: Query/Prepare Parameter Groups

> If the existing Worker cluster's parameter groups already contain the required parameters (`pg_stat_statements`, `pg_cron`, `logical_replication`, etc.), you can reuse them directly and skip to Step 3.

### 3.A Reuse Existing Parameter Groups

```bash
# Query existing cluster parameter groups
aws rds describe-db-cluster-parameter-groups \
  --query "DBClusterParameterGroups[*].{Name:DBClusterParameterGroupName,Family:DBParameterGroupFamily,Description:Description}" \
  --output table --region $REGION

# Check key parameter values for a specific group (replace <parameter-group-name>)
aws rds describe-db-cluster-parameters \
  --db-cluster-parameter-group-name "<parameter-group-name>" \
  --query "Parameters[?ParameterName=='shared_preload_libraries' || ParameterName=='rds.logical_replication' || ParameterName=='max_slot_wal_keep_size'].{Name:ParameterName,Value:ParameterValue}" \
  --output table --region $REGION

# Query existing instance parameter groups
aws rds describe-db-parameter-groups \
  --query "DBParameterGroups[*].{Name:DBParameterGroupName,Family:DBParameterGroupFamily,Description:Description}" \
  --output table --region $REGION

# Check key parameter values for a specific instance parameter group
aws rds describe-db-parameters \
  --db-parameter-group-name "<parameter-group-name>" \
  --query "Parameters[?ParameterName=='log_min_duration_statement' || ParameterName=='auto_explain.log_min_duration'].{Name:ParameterName,Value:ParameterValue}" \
  --output table --region $REGION
```

Once confirmed the parameter values meet your requirements, set the environment variables:

```bash
export CLUSTER_PG_NAME="<existing-cluster-parameter-group-name>"
export DB_PG_NAME="<existing-instance-parameter-group-name>"
```

### 3.B Create New Parameter Groups (if existing ones don't meet requirements)

```bash
export CLUSTER_PG_NAME="${CLUSTER_ID}-cluster-pg"
export DB_PG_NAME="${CLUSTER_ID}-db-pg"

# Create cluster parameter group
aws rds create-db-cluster-parameter-group \
  --db-cluster-parameter-group-name "$CLUSTER_PG_NAME" \
  --db-parameter-group-family aurora-postgresql16 \
  --description "Custom cluster parameter group for Supabase new worker Aurora cluster" \
  --region $REGION

# Set cluster parameters
aws rds modify-db-cluster-parameter-group \
  --db-cluster-parameter-group-name "$CLUSTER_PG_NAME" \
  --parameters \
    "ParameterName=shared_preload_libraries,ParameterValue='pg_stat_statements,pg_cron',ApplyMethod=pending-reboot" \
    "ParameterName=rds.logical_replication,ParameterValue=1,ApplyMethod=pending-reboot" \
    "ParameterName=max_slot_wal_keep_size,ParameterValue=1024,ApplyMethod=immediate" \
  --region $REGION

# Create instance parameter group
aws rds create-db-parameter-group \
  --db-parameter-group-name "$DB_PG_NAME" \
  --db-parameter-group-family aurora-postgresql16 \
  --description "Custom DB parameter group for Supabase new worker Aurora instances" \
  --region $REGION

# Set instance parameters
aws rds modify-db-parameter-group \
  --db-parameter-group-name "$DB_PG_NAME" \
  --parameters \
    "ParameterName=log_min_duration_statement,ParameterValue=1000,ApplyMethod=immediate" \
    "ParameterName=auto_explain.log_min_duration,ParameterValue=1000,ApplyMethod=immediate" \
  --region $REGION
```

> **Parameter Details**:
> - `shared_preload_libraries`: Loads `pg_stat_statements` (query statistics) and `pg_cron` (scheduled jobs), requires reboot
> - `rds.logical_replication`: Enables logical replication (required by Supabase Realtime), requires reboot
> - `max_slot_wal_keep_size`: Limits replication slot WAL size to 1024MB, prevents disk from filling up
> - `log_min_duration_statement`: Logs SQL statements exceeding 1000ms
> - `auto_explain.log_min_duration`: Automatically logs execution plans for queries exceeding 1000ms

---

## 4. Step 3: Query/Prepare Security Groups

> If the existing Worker cluster's security group already allows connections from Tenant Manager, Lambda, postgres-meta, and Auth service on port 5432, you can reuse it directly and skip to Step 4.

### 4.A Reuse Existing Security Group

```bash
# Query security groups used by existing Worker clusters
aws rds describe-db-clusters \
  --query "DBClusters[*].{ClusterID:DBClusterIdentifier,SecurityGroups:VpcSecurityGroups[*].VpcSecurityGroupId}" \
  --output table --region $REGION

# Check inbound rules for a specific security group (replace <security-group-id>)
aws ec2 describe-security-groups \
  --group-ids "<security-group-id>" \
  --query "SecurityGroups[0].IpPermissions[*].{Port:FromPort,Protocol:IpProtocol,Sources:UserIdGroupPairs[*].GroupId}" \
  --output table --region $REGION
```

Once confirmed the inbound rules include the required service security groups, set the environment variable:

```bash
export WORKER_SG_ID="<existing-security-group-id>"
```

### 4.B Create New Security Group (if existing ones don't meet requirements)

```bash
# Get the service security group IDs to allow
export TM_SG_ID="sg-xxxxxxxx"       # Tenant Manager security group
export LAMBDA_SG_ID="sg-xxxxxxxx"   # Lambda security group
export PG_META_SG_ID="sg-xxxxxxxx"  # postgres-meta security group
export AUTH_SG_ID="sg-xxxxxxxx"     # Auth service security group

# Create security group
WORKER_SG_ID=$(aws ec2 create-security-group \
  --group-name "${CLUSTER_ID}-sg" \
  --description "Security group for Supabase New Worker Aurora PostgreSQL" \
  --vpc-id "$VPC_ID" \
  --query "GroupId" \
  --output text \
  --region $REGION)

echo "New security group ID: $WORKER_SG_ID"

# Add inbound rules
for SG in $TM_SG_ID $LAMBDA_SG_ID $PG_META_SG_ID $AUTH_SG_ID; do
  aws ec2 authorize-security-group-ingress \
    --group-id "$WORKER_SG_ID" \
    --protocol tcp \
    --port $DB_PORT \
    --source-group "$SG" \
    --region $REGION
done

echo "Added inbound rules for Tenant Manager / Lambda / postgres-meta / Auth"
```

---

## 5. Step 4: Create Aurora Serverless v2 Cluster (IO/Optimized)

### 5.1 Create Aurora Cluster

```bash
aws rds create-db-cluster \
  --db-cluster-identifier "$CLUSTER_ID" \
  --engine aurora-postgresql \
  --engine-version "$ENGINE_VERSION" \
  --master-username "$DB_MASTER_USER" \
  --master-user-password "$DB_PASSWORD" \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --vpc-security-group-ids "$WORKER_SG_ID" \
  --db-cluster-parameter-group-name "$CLUSTER_PG_NAME" \
  --storage-type aurora-iopt1 \
  --storage-encrypted \
  --serverless-v2-scaling-configuration MinCapacity=$MIN_ACU,MaxCapacity=$MAX_ACU \
  --backup-retention-period $BACKUP_RETENTION \
  --deletion-protection \
  --database-name postgres \
  --region $REGION
```

> **Key Parameters**:
> - `--storage-type aurora-iopt1`: IO/Optimized storage, no additional I/O charges
> - `--serverless-v2-scaling-configuration`: Test 0.5-4 ACU, Production 2-16 ACU
> - `--backup-retention-period`: Test 7 days, Production 30 days
> - `--deletion-protection`: Recommended for production; remove this flag for test environments
> - `--storage-encrypted`: Enables storage encryption

### 5.2 Wait for Cluster to Become Available

```bash
echo "Waiting for cluster creation (approximately 5-10 minutes)..."
aws rds wait db-cluster-available \
  --db-cluster-identifier "$CLUSTER_ID" \
  --region $REGION
echo "Cluster creation complete"
```

### 5.3 Create Serverless v2 Writer Instance

```bash
aws rds create-db-instance \
  --db-instance-identifier "$INSTANCE_ID" \
  --db-instance-class db.serverless \
  --engine aurora-postgresql \
  --db-cluster-identifier "$CLUSTER_ID" \
  --db-parameter-group-name "$DB_PG_NAME" \
  --region $REGION
```

### 5.4 Wait for Instance to Become Available

```bash
echo "Waiting for writer instance creation (approximately 5-10 minutes)..."
aws rds wait db-instance-available \
  --db-instance-identifier "$INSTANCE_ID" \
  --region $REGION
echo "Writer instance creation complete"
```

### 5.5 Verify Cluster Status

```bash
aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --query "DBClusters[0].{Status:Status,Engine:Engine,EngineVersion:EngineVersion,StorageType:StorageType,Endpoint:Endpoint,Port:Port}" \
  --output table --region $REGION
```

Expected output:
```
-----------------------------------------------------------
|                    DescribeDBClusters                    |
+-----------------+---------------------------------------+
|  Engine         |  aurora-postgresql                     |
|  EngineVersion  |  16.8                                 |
|  Status         |  available                            |
|  StorageType    |  aurora-iopt1                         |
+-----------------+---------------------------------------+
```

### 5.6 Get Cluster Endpoints

```bash
CLUSTER_ENDPOINT=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --query "DBClusters[0].Endpoint" \
  --output text --region $REGION)

READER_ENDPOINT=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --query "DBClusters[0].ReaderEndpoint" \
  --output text --region $REGION)

echo "Writer endpoint: $CLUSTER_ENDPOINT"
echo "Reader endpoint: $READER_ENDPOINT"
```

---

## 6. Step 5: (Production) Create Reader Replica

> Production only. For test environments, skip this step and proceed to Step 6.

Reader Replicas provide read/write separation, offloading read-only queries to reader instances and reducing writer load.

### 6.1 Create Reader Instance(s)

```bash
if [ "$READER_COUNT" -gt 0 ]; then
  for i in $(seq 1 $READER_COUNT); do
    READER_ID="${CLUSTER_ID}-reader-${i}"
    echo "Creating Reader ${i}: $READER_ID"

    aws rds create-db-instance \
      --db-instance-identifier "$READER_ID" \
      --db-instance-class db.serverless \
      --engine aurora-postgresql \
      --db-cluster-identifier "$CLUSTER_ID" \
      --db-parameter-group-name "$DB_PG_NAME" \
      --region $REGION

    echo "Waiting for Reader ${i} creation..."
    aws rds wait db-instance-available \
      --db-instance-identifier "$READER_ID" \
      --region $REGION
    echo "Reader ${i} creation complete"
  done
else
  echo "Test environment — skipping Reader creation"
fi
```

### 6.2 Verify Reader Instance(s)

```bash
aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --query "DBClusters[0].DBClusterMembers[*].{InstanceID:DBInstanceIdentifier,IsWriter:IsClusterWriter}" \
  --output table --region $REGION
```

Expected output (production):
```
-------------------------------------------------
|             DBClusterMembers                  |
+--------------------------------------+--------+
|  InstanceID                          | IsWriter|
+--------------------------------------+--------+
|  supabase-new-worker-cluster-prod-writer   |  True  |
|  supabase-new-worker-cluster-prod-reader-1 |  False |
+--------------------------------------+--------+
```

### 6.3 Endpoint Usage

Aurora clusters provide two endpoints:

| Endpoint Type | Usage | Environment Variable |
|--------------|-------|---------------------|
| Writer Endpoint (`Endpoint`) | Read/write operations, DDL, transactional writes | `$CLUSTER_ENDPOINT` |
| Reader Endpoint (`ReaderEndpoint`) | Read-only queries, reports, analytics | `$READER_ENDPOINT` |

> Use the Writer endpoint when registering with Tenant Manager. The Reader endpoint can be used for application-level read/write splitting.

---

## 7. Step 6: Store Credentials in Secrets Manager

### 7.1 Create Secret

```bash
SECRET_ARN=$(aws secretsmanager create-secret \
  --name "supabase/${CLUSTER_ID}/credentials" \
  --description "Credentials for Supabase new worker Aurora cluster (${ENV_TYPE})" \
  --secret-string "{
    \"username\": \"${DB_MASTER_USER}\",
    \"password\": \"${DB_PASSWORD}\",
    \"engine\": \"postgres\",
    \"host\": \"${CLUSTER_ENDPOINT}\",
    \"reader_host\": \"${READER_ENDPOINT}\",
    \"port\": ${DB_PORT},
    \"dbClusterIdentifier\": \"${CLUSTER_ID}\"
  }" \
  --query "ARN" \
  --output text \
  --region $REGION)

echo "Secret ARN: $SECRET_ARN"
```

### 7.2 Verify Credentials

```bash
aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ARN" \
  --query "SecretString" \
  --output text --region $REGION | jq .
```

### 7.3 Test Database Connection

```bash
# Must be executed from a bastion host or ECS container within the VPC
psql "host=$CLUSTER_ENDPOINT port=$DB_PORT dbname=postgres user=$DB_MASTER_USER password=$DB_PASSWORD sslmode=require"
```

---

## 8. Step 7: Register Database with Supabase Tenant Manager via API

### 8.1 Get Admin API Key

```bash
ADMIN_API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id "supabase/admin-api-key" \
  --query "SecretString" \
  --output text --region $REGION)
```

### 8.2 Set Tenant Manager Endpoint

```bash
TM_BASE_URL="https://studio.yourdomain.com"
```

### 8.3 Register New RDS Instance

```bash
curl -X POST "${TM_BASE_URL}/admin/v1/rds-instances" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "new-worker-cluster",
    "name": "New Worker Cluster (IO/Optimized, PG 16.8)",
    "host": "'${CLUSTER_ENDPOINT}'",
    "port": '${DB_PORT}',
    "admin_user": "'${DB_MASTER_USER}'",
    "admin_password": "'${DB_PASSWORD}'",
    "region": "'${REGION}'",
    "max_databases": 100,
    "weight": 1
  }'
```

Expected success response (HTTP 201):
```json
{
  "id": 3,
  "identifier": "new-worker-cluster",
  "name": "New Worker Cluster (IO/Optimized, PG 16.8)",
  "host": "supabase-new-worker-cluster.cluster-xxxxxxxxx.us-east-1.rds.amazonaws.com",
  "port": 5432,
  "region": "us-east-1",
  "status": "active",
  "max_databases": 100,
  "current_databases": 0,
  "weight": 1,
  "created_at": "2025-01-01T00:00:00.000Z",
  "updated_at": "2025-01-01T00:00:00.000Z"
}
```

### 8.4 Verify Registration

```bash
curl -s "${TM_BASE_URL}/admin/v1/rds-instances" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" | jq .
```

### 8.5 Common Error Handling

| Status Code | Cause | Resolution |
|-------------|-------|------------|
| 400 | Missing required fields | Check that the request body includes all required fields |
| 401 | Invalid API Key | Re-fetch `supabase/admin-api-key` from Secrets Manager |
| 409 | Identifier already exists | Use a different identifier or delete the existing instance first |
| 500 | Server error | Check Tenant Manager logs: `aws logs tail /ecs/supabase --filter-pattern tenant-manager` |

---

## 9. Step 8: RDS Instance Management Endpoint Demo

### 9.1 List All RDS Instances

```bash
curl -s "${TM_BASE_URL}/admin/v1/rds-instances" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" | jq .
```

### 9.2 Get Single RDS Instance Details

```bash
curl -s "${TM_BASE_URL}/admin/v1/rds-instances/3" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" | jq .
```

### 9.3 Update RDS Instance Configuration

```bash
curl -X PATCH "${TM_BASE_URL}/admin/v1/rds-instances/3" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "max_databases": 200,
    "weight": 2
  }'
```

### 9.4 Set Instance to Draining Status

> Draining means the instance will no longer accept new project assignments, but existing projects continue running. Used for planned maintenance or decommissioning.

```bash
curl -X POST "${TM_BASE_URL}/admin/v1/rds-instances/3/drain" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}"
```

### 9.5 List Projects on an Instance

```bash
curl -s "${TM_BASE_URL}/admin/v1/rds-instances/3/projects" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" | jq .
```

### 9.6 TypeScript Example Code

```typescript
// rds-instance-management.ts
// Tenant Manager RDS Instance Management API Example

// ============ Type Definitions ============

interface AddRdsInstanceRequest {
  identifier: string;
  name: string;
  host: string;
  port: number;
  admin_user: string;
  admin_password: string;
  region: string;
  max_databases: number;
  weight?: number;
}

interface UpdateRdsInstanceRequest {
  name?: string;
  max_databases?: number;
  weight?: number;
}

interface RdsInstance {
  id: number;
  identifier: string;
  name: string;
  host: string;
  port: number;
  region: string;
  status: 'active' | 'draining' | 'maintenance' | 'offline';
  max_databases: number;
  current_databases: number;
  weight: number;
  created_at: string;
  updated_at: string;
}

interface DrainResponse {
  id: number;
  status: 'draining';
  projects_count: number;
  message: string;
}

interface ProjectSummary {
  id: number;
  ref: string;
  name: string;
  status: string;
  created_at: string;
}

interface PaginatedProjects {
  pagination: { count: number; limit: number; offset: number };
  projects: ProjectSummary[];
}

interface ApiError {
  statusCode: number;
  error: string;
  message: string;
}

// ============ API Client ============

class TenantManagerClient {
  constructor(
    private baseUrl: string,
    private apiKey: string
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const error: ApiError = await res.json();
      throw new Error(`API Error [${res.status}]: ${error.message}`);
    }

    return res.json() as Promise<T>;
  }

  async addInstance(data: AddRdsInstanceRequest): Promise<RdsInstance> {
    return this.request<RdsInstance>('POST', '/admin/v1/rds-instances', data);
  }

  async listInstances(): Promise<RdsInstance[]> {
    return this.request<RdsInstance[]>('GET', '/admin/v1/rds-instances');
  }

  async getInstance(id: number): Promise<RdsInstance> {
    return this.request<RdsInstance>('GET', `/admin/v1/rds-instances/${id}`);
  }

  async updateInstance(id: number, data: UpdateRdsInstanceRequest): Promise<RdsInstance> {
    return this.request<RdsInstance>('PATCH', `/admin/v1/rds-instances/${id}`, data);
  }

  async drainInstance(id: number): Promise<DrainResponse> {
    return this.request<DrainResponse>('POST', `/admin/v1/rds-instances/${id}/drain`);
  }

  async listInstanceProjects(id: number): Promise<PaginatedProjects> {
    return this.request<PaginatedProjects>('GET', `/admin/v1/rds-instances/${id}/projects`);
  }
}

// ============ Usage Example ============

async function main() {
  const client = new TenantManagerClient(
    'https://studio.yourdomain.com',
    'your-admin-api-key'
  );

  // 1. Register new RDS instance
  const instance = await client.addInstance({
    identifier: 'new-worker-cluster',
    name: 'New Worker Cluster (IO/Optimized, PG 16.8)',
    host: 'supabase-new-worker-cluster.cluster-xxx.us-east-1.rds.amazonaws.com',
    port: 5432,
    admin_user: 'postgres',
    admin_password: 'your-password-from-secrets-manager',
    region: 'us-east-1',
    max_databases: 100,
    weight: 1,
  });
  console.log('Registration successful:', instance);

  // 2. List all instances
  const instances = await client.listInstances();
  instances.forEach(i =>
    console.log(`${i.identifier} (${i.status}): ${i.current_databases}/${i.max_databases}`)
  );

  // 3. Update instance configuration
  const updated = await client.updateInstance(instance.id, { max_databases: 200, weight: 2 });
  console.log('Updated:', updated);

  // 4. List instance projects
  const projects = await client.listInstanceProjects(instance.id);
  console.log(`Total projects: ${projects.pagination.count}`);

  // 5. Set draining (for planned maintenance)
  // const drain = await client.drainInstance(instance.id);
}

main().catch(console.error);
```

---

## Appendix: Quick Reference

```
1. Configure environment variables (set ENV_TYPE=prod or test)
2. Query existing parameter groups → reuse if they meet requirements, otherwise create new
3. Query existing security groups → reuse if they meet requirements, otherwise create new
4. Create cluster → aws rds create-db-cluster (aurora-iopt1)
5. Create Writer instance → aws rds create-db-instance (db.serverless)
6. (Production) Create Reader Replica → aws rds create-db-instance
7. Store credentials → aws secretsmanager create-secret
8. Register with Tenant Manager → POST /admin/v1/rds-instances
9. Verify → GET /admin/v1/rds-instances
```
