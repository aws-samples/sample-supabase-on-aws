# Supabase-on-AWS 部署指南

> 本文档为 Claude Code 可直接执行的自动化部署指南。
>
> 人工操作仅需：提供部署参数、完成 DNS 验证、配置 DNS CNAME 记录。

---

## 部署参数（用户需提供）

部署前需确认以下参数：

| 参数 | 说明 | 示例 |
|------|------|------|
| `AWS_ACCOUNT_ID` | AWS 账号 ID | `123456789012` |
| `AWS_REGION` | 部署目标区域 | `us-west-2` |
| `BASE_DOMAIN` | 域名（需有 DNS 管理权限） | `supabase.example.com` |
| DNS 服务商 | Cloudflare / Route53 / 其他 | Cloudflare |

## 前置条件

| 工具 | 版本要求 | 用途 |
|------|---------|------|
| AWS CLI | v2+ | AWS 资源管理 |
| Node.js | v18+ | CDK 编译 |
| Docker | v20+ | 镜像构建（需 linux/amd64 平台支持） |
| AWS CDK | v2.100+ | 基础设施部署（`npm install -g aws-cdk` 或通过 npx） |
| jq | v1.6+ | JSON 处理 |
| Python | v3.9+ | 运行测试 |
| pnpm | v10+ | function-deploy 依赖管理 |

AWS 账号需具备 `AdministratorAccess` 权限。

---

## 步骤 0：清理 CLAUDE.md 中的硬编码信息（如有）

**目的**：确保 `CLAUDE.md` 中没有上一个部署环境的硬编码账号、域名、安全组 ID 等。

检查并替换以下内容为通用占位符：
- AWS Account ID → `See config.json → project.accountId`
- 域名 → `See config.json → domain.baseDomain`
- ACM Certificate ARN → `See config.json → infraStack.certificate.arn`
- 安全组 ID（`sg-xxx`）→ 移除 ID 列，保留名称和规则描述
- ECR URI 中的硬编码账号 → `<account_id>.dkr.ecr.<region>.amazonaws.com/...`
- 命令示例中的硬编码域名 → `<baseDomain>` 占位符

**验证**：`grep -E '(旧账号ID|旧域名)' CLAUDE.md` 应无匹配。

---

## 步骤 1：申请 ACM 证书

```bash
aws acm request-certificate \
  --domain-name "*.${BASE_DOMAIN}" \
  --validation-method DNS \
  --region ${AWS_REGION}
```

记录返回的 `CertificateArn`。

获取 DNS 验证记录：

```bash
aws acm describe-certificate \
  --certificate-arn <证书ARN> \
  --region ${AWS_REGION} \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

**需要用户操作**：在 DNS 服务商添加返回的 CNAME 验证记录，等待证书状态变为 `Issued`。

验证：

```bash
aws acm describe-certificate \
  --certificate-arn <证书ARN> \
  --region ${AWS_REGION} \
  --query 'Certificate.Status' \
  --output text
# 期望输出: ISSUED
```

---

## 步骤 2：创建并修改 config.json

### 2.1 选择环境模板

项目提供两个配置模板，根据目标环境选择：

```bash
# 测试环境
cp config.test.json config.json

# 生产环境
cp config.production.json config.json
```

### 2.2 测试环境与生产环境配置对比

`config.json` 中的 `project.environment` 字段（`test` 或 `production`）驱动基础设施行为差异：

| 配置项 | Test | Production | 说明 |
|--------|------|------------|------|
| **VPC** | | | |
| `infraStack.vpc.maxAzs` | 2 | 3 | 可用区数量 |
| `infraStack.vpc.natGateways` | 1 | 2 | NAT 网关（影响跨 AZ 出口冗余） |
| **RDS（管理库 + Worker 库）** | | | |
| `rds.serverlessV2MinCapacity` | 0.5 | 1 | 最小 ACU（0.5 = 可暂停） |
| `rds.serverlessV2MaxCapacity` | 4 | 16 | 最大 ACU |
| `rds.readers` | 0 | 1 | 只读副本数（0 = 仅 writer） |
| `workerRds.serverlessV2MinCapacity` | 0.5 | 1 | Worker 库最小 ACU |
| `workerRds.serverlessV2MaxCapacity` | 4 | 16 | Worker 库最大 ACU |
| `workerRds.readers` | 0 | 1 | Worker 库只读副本数 |
| **Redis** | | | |
| `redis.nodeType` | `cache.t3.micro` | `cache.r6g.large` | 实例规格 |
| `redis.numCacheClusters` | 1 | 2 | 节点数（2 = 多 AZ 故障转移） |
| **ECS 服务** | | | |
| Kong | 512 CPU / 1024 MB / 1 实例 | 2048 CPU / 4096 MB / 2 实例 | 网关层 |
| Tenant Manager | 512 / 1024 / 1 | 1024 / 2048 / 2 | 项目管理 |
| Studio | 512 / 1024 / 1 | 1024 / 2048 / 2 | 管理界面 |
| Functions | 512 / 1024 / 1 | 1024 / 2048 / 2 | Edge Functions |
| Function Deploy | 256 / 512 / 1 | 512 / 1024 / 2 | 函数部署 |
| Postgres Meta | 256 / 512 / 1 | 512 / 1024 / 2 | 数据库元数据 |
| Auth | 256 / 512 / 1 | 512 / 1024 / 2 | 认证服务 |
| **数据保护** | | | |
| RDS deletionProtection | `false` | `true` | 删除保护 |
| RDS removalPolicy | `DESTROY` | `RETAIN` | CDK 删除策略 |
| 备份保留 | 7 天 | 30 天 | 自动备份 |

**预估月度成本**（us-east-1 参考）：

| 资源 | Test | Production |
|------|------|------------|
| VPC（NAT Gateway） | ~$35 | ~$70 |
| RDS（管理库 + Worker） | ~$90 | ~$450 |
| Redis | ~$15 | ~$300 |
| ECS Fargate（7 服务） | ~$120 | ~$600 |
| ALB x 2 | ~$40 | ~$40 |
| **合计** | **~$300/月** | **~$1,460/月** |

### 2.3 填入部署参数

编辑 `config.json`，替换占位符：

| 字段 | 修改为 |
|------|--------|
| `project.region` | `${AWS_REGION}` |
| `project.accountId` | `${AWS_ACCOUNT_ID}` |
| `infraStack.certificate.arn` | 步骤 1 获得的证书 ARN |
| `domain.baseDomain` | `${BASE_DOMAIN}` |
| `tags.DeploymentDate` | 当前日期（如 `2026-02-28`） |

ECR 仓库地址由 `accountId` + `region` 在构建脚本中自动拼接，无需手动配置。

### 2.4 切换环境

如需从测试环境切换到生产环境（或反之）：

```bash
# 1. 备份当前配置
cp config.json config.$(jq -r '.project.environment' config.json).bak.json

# 2. 切换模板（保留自己的 accountId、region、certificate、domain）
TARGET=production  # 或 test
jq -s '.[0] * {
  project: {region: .[1].project.region, accountId: .[1].project.accountId, name: .[1].project.name},
  infraStack: {certificate: .[1].infraStack.certificate},
  domain: .[1].domain
}' config.${TARGET}.json config.json > config.new.json
mv config.new.json config.json

# 3. 重新部署
cd infra && npm run build && npx cdk deploy SupabaseStack --require-approval never

# 4. 强制 ECS 重新部署（资源规格变更需重启任务）
for svc in kong-gateway tenant-manager studio functions-service postgres-meta function-deploy auth-service; do
  aws ecs update-service --cluster infrastack-cluster --service "$svc" --force-new-deployment --region ${AWS_REGION}
done
```

> **注意**：从 test 切换到 production 是**非破坏性**升级（增加副本、扩大容量）。从 production 切换到 test 会**缩减副本**并降低保护级别，请确保已备份数据。

**验证**：

```bash
jq '{env: .project.environment, region: .project.region, accountId: .project.accountId, certArn: .infraStack.certificate.arn, baseDomain: .domain.baseDomain}' config.json
```

---

## 步骤 3：CDK Bootstrap（仅首次部署）

```bash
cd infra && npm install
npx cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_REGION}
```

**验证**：输出包含 `Environment aws://.../... bootstrapped`。

---

## 步骤 4：构建并推送 Docker 镜像

### 4.1 预处理：生成缺失的 lockfile

构建脚本要求每个服务目录有完整的依赖 lockfile。以下两个服务需要预先生成：

**tenant-manager**（需要 `package-lock.json`）：

```bash
cd app/tenant-manager
# 如果 npm install 报 arborist 错误，先清理缓存
rm -rf node_modules /home/$USER/.npm/_cacache
npm install
cd ../..
```

**function-deploy**（需要 `pnpm-lock.yaml`）：

```bash
cd app/function-deploy
pnpm install --lockfile-only
cd ../..
```

> **已知问题**：npm 10.x 在某些环境下会出现 `Cannot read properties of null (reading 'matches')` 错误，通过删除 `~/.npm/_cacache` 可解决。

### 4.2 构建全部服务

```bash
./build-and-push.sh
```

构建 7 个服务：functions、kong、postgrest-lambda、tenant-manager、postgres-meta、studio、function-deploy。

脚本会自动：
- 登录 ECR（私有 + 公共）
- 创建不存在的 ECR 仓库（含生命周期策略：保留 10 个最新镜像）
- 构建 linux/amd64 镜像
- 推送 `latest` 和 `git-sha` 两个标签

如果某个服务构建失败，可单独重建：

```bash
./build-and-push.sh <服务名>
# 可用服务名: functions | kong | postgrest-lambda | tenant-manager | postgres-meta | studio | function-deploy
```

**验证**：

```bash
aws ecr describe-repositories --region ${AWS_REGION} --query 'repositories[*].repositoryName' --output json
# 期望包含: functions-service, kong-configured, postgrest-lambda, tenant-manager, postgres-meta, studio, function-deploy
```

---

## 步骤 5：部署基础设施

```bash
cd infra
npm run build
npx cdk deploy SupabaseStack --require-approval never
```

预计创建约 **159 个 AWS 资源**，耗时 **10-15 分钟**。

创建的主要资源：
- VPC（2 AZ、1 NAT Gateway）
- Aurora Serverless v2 × 2（管理集群 + Worker 集群）
- ECS Fargate 服务 × 7（Kong、Tenant Manager、Studio、Functions、Function Deploy、Postgres Meta、Project Service）
- ALB × 2（Kong ALB + Studio ALB）
- ElastiCache Redis（AUTH + TLS）
- EFS（Functions 存储）
- WAF WebACL
- CloudWatch 告警
- Cloud Map 服务发现

### 5.1 设置 ECR Lambda 拉取权限

CDK 部署完成后，需要给 `postgrest-lambda` ECR 仓库添加 Lambda 拉取权限，否则创建项目时 Lambda 无法拉取镜像：

```bash
aws ecr set-repository-policy \
  --repository-name postgrest-lambda \
  --region ${AWS_REGION} \
  --policy-text '{
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "LambdaECRAccess",
      "Effect": "Allow",
      "Principal": {"Service": "lambda.amazonaws.com"},
      "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      "Condition": {
        "StringLike": {
          "aws:sourceArn": "arn:aws:lambda:'${AWS_REGION}':'${AWS_ACCOUNT_ID}':function:*"
        }
      }
    }]
  }'
```

> **已知问题**：CDK 创建的 Lambda 执行角色有 ECR 权限，但 ECR 仓库策略默认不允许 Lambda 服务拉取。不设置此策略会导致创建项目时报错 `Lambda does not have permission to access the ECR image`。

### 5.2 记录部署输出

```bash
aws cloudformation describe-stacks \
  --stack-name SupabaseStack --region ${AWS_REGION} \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table
```

关键输出值：

| 输出键 | 用途 |
|--------|------|
| `ALBDnsName` | Kong ALB DNS，DNS CNAME 目标 |
| `StudioALBDnsName` | Studio ALB DNS |
| `RdsEndpoint` | 管理数据库端点 |
| `WorkerRdsEndpoint` | Worker 数据库端点 |
| `RedisEndpoint` | Redis 端点 |
| `LambdaExecutionRoleArn` | Lambda 执行角色 |
| `LambdaSgId` | Lambda 安全组 |

---

## 步骤 6：配置 DNS

**需要用户操作**：在 DNS 服务商添加通配符 CNAME 记录。

| 记录名 | 类型 | 值 | 注意 |
|--------|------|---|------|
| `*.${BASE_DOMAIN}` | CNAME | `<ALBDnsName 输出值>` | 关闭 CDN 代理（如 Cloudflare 灰云模式） |

> **Cloudflare 用户注意**：
> - 记录名称填写 `*`（在 `${BASE_DOMAIN}` 域下），Cloudflare 会自动追加域名后缀
> - **必须关闭代理**（DNS only / 灰云），否则 ACM 证书的 SNI 匹配会失败
> - 如果域名是多级子域（如 `supabase.example.com`），记录名称应填 `*.supabase`（在 `example.com` 域下）

**验证**：

```bash
nslookup test.${BASE_DOMAIN} 1.1.1.1
# 期望输出: canonical name = <ALBDnsName>，解析到 ALB IP
```

---

## 步骤 7：注册 Worker 数据库并创建首个项目

```bash
./scripts/provision-worker-and-create-project.sh
```

脚本自动完成：
1. 从 CloudFormation 输出获取 Worker RDS 端点和密码
2. 从 Secrets Manager 获取 Admin API Key
3. 向 Tenant Manager 注册 Worker RDS 实例
4. 创建测试项目（初始化数据库 schema、创建 PostgREST Lambda、注册 Kong 消费者、生成 API 密钥）

成功输出示例：
```
  Worker RDS:     supabase-worker-cluster.cluster-xxx.us-west-2.rds.amazonaws.com
  Instance ID:    supabase-worker-01
  Project Ref:    fd03vkjr73dptzl8bihy
```

**验证**：

```bash
# 获取 Studio ALB
STUDIO_ALB=$(aws cloudformation describe-stacks \
  --stack-name SupabaseStack --region ${AWS_REGION} \
  --query 'Stacks[0].Outputs[?OutputKey==`StudioALBDnsName`].OutputValue' \
  --output text)

# 列出项目
curl -sk "https://${STUDIO_ALB}/api/v1/projects" | jq '.[].ref'
```

---

## 步骤 8：运行自动化测试

```bash
cd tests
pip install -r requirements.txt
./RUN_TESTS.sh
```

期望结果：**34 passed, 3 skipped**。

测试覆盖：

| 组 | 测试数 | 内容 |
|----|--------|------|
| A: 项目创建 | 2 | 通过 Studio API 创建项目 |
| B: API 密钥 | 2 | 获取并验证 opaque 格式密钥 |
| C: SQL CRUD | 8 | 通过 Studio SQL 端点增删改查 |
| D: 元数据 | 2 | 9 个元数据端点（tables、views、extensions 等） |
| E: Secrets | 3（跳过） | Secrets 管理（未实现） |
| F: 表 CRUD | 8 | DDL + DML 完整生命周期 |
| G: SDK CRUD + RLS | 8 | Supabase SDK 操作 + 行级安全验证 |
| H: 无效密钥 | 4 | 随机密钥、伪造密钥、空密钥、无密钥均返回 401 |

---

## 部署验证清单

全部步骤完成后，逐项确认：

- [ ] 所有 ECS 服务 `runningCount == desiredCount`
  ```bash
  aws ecs describe-services --cluster infrastack-cluster \
    --services kong-gateway tenant-manager studio functions-service function-deploy postgres-meta \
    --region ${AWS_REGION} \
    --query 'services[*].[serviceName,runningCount,desiredCount]' --output table
  ```
- [ ] 自动化测试 34 passed, 3 skipped
- [ ] SDK 端点可访问：`https://<project_ref>.${BASE_DOMAIN}/rest/v1/`

---

## 日常运维

### 更新服务代码

```bash
# 1. 构建并推送新镜像
./build-and-push.sh <服务名>

# 2. 强制 ECS 拉取新镜像
aws ecs update-service --cluster infrastack-cluster \
  --service <ECS服务名> --force-new-deployment --region ${AWS_REGION}
```

| 构建目标 | ECS 服务名 |
|---------|-----------|
| kong | kong-gateway |
| tenant-manager | tenant-manager |
| studio | studio |
| functions | functions-service |
| function-deploy | function-deploy |
| postgres-meta | postgres-meta |

### 查看日志

```bash
aws logs tail /ecs/supabase --since 10m --region ${AWS_REGION}
aws logs tail /ecs/supabase --since 5m --filter-pattern "tenant-manager" --region ${AWS_REGION}
```

### 更新基础设施

```bash
cd infra && npm run build
npx cdk diff SupabaseStack      # 预览变更
npx cdk deploy SupabaseStack    # 执行变更
```

---

## 已知问题与解决方案

### 1. tenant-manager 构建失败：缺少 package-lock.json

**现象**：`COPY package.json package-lock.json ./` 报 `/package-lock.json: not found`

**解决**：在 `app/tenant-manager/` 目录执行 `npm install` 生成 lockfile。如遇 npm arborist 错误，先 `rm -rf ~/.npm/_cacache`。

### 2. function-deploy 构建失败：缺少 pnpm-lock.yaml

**现象**：turbo prune 报 `lockfile not found at /app/pnpm-lock.yaml`

**解决**：在 `app/function-deploy/` 目录执行 `pnpm install --lockfile-only`。

### 3. 创建项目报 ECR 权限错误

**现象**：`Lambda does not have permission to access the ECR image`

**解决**：执行步骤 5.1 的 `aws ecr set-repository-policy` 命令。

### 4. DNS 不生效（NXDOMAIN）

**现象**：`nslookup test.${BASE_DOMAIN}` 返回 NXDOMAIN

**排查**：
- Cloudflare 记录名称是否正确（多级子域需拆分，如 `*.supabase` 在 `example.com` 域下）
- 是否使用了完整域名导致重复追加后缀
- DNS 传播可能需要几分钟

### 5. Kong 返回 401 Unauthorized

**排查**：
1. 确认使用 opaque 密钥（`sb_publishable_*` / `sb_secret_*`），而非 JWT
2. 请求需同时设置 `apikey` 和 `Authorization: Bearer` 两个 Header
3. 重新获取密钥：`curl -sk "https://${STUDIO_ALB}/api/v1/projects/${REF}/api-keys" | jq .`

### 6. 创建项目超时

**说明**：首次创建项目需 2-3 分钟（Lambda VPC ENI 冷启动），Studio ALB 空闲超时已设为 400 秒，通常不会超时。如超时，检查 Tenant Manager 日志。

---

## 架构参考

### 请求流程（Gateway JWT Minting）

```
客户端（Supabase SDK）
  │  apikey: sb_publishable_xxx
  │  Authorization: Bearer sb_publishable_xxx
  ▼
Kong ALB (*.baseDomain:443)
  ▼
Kong Gateway（ECS Fargate）
  ├─ pre-function：子域名 → X-Project-ID
  ├─ key-auth：验证 opaque API 密钥 → 识别消费者/角色
  ├─ dynamic-lambda-router：
  │    1. Redis 缓存查询（jwt_secret + lambda_url）
  │    2. 缓存未命中 → GET tenant-manager /project/{id}/config
  │    3. 铸造短效 JWT（5分钟，HS256，role=anon|service_role）
  │    4. SigV4 签名 → POST Lambda Function URL
  ▼
PostgREST Lambda → 验证 JWT → SET LOCAL role → SQL + RLS
  ▼
Worker Aurora（租户数据库）
```

### API 密钥格式

| 类型 | 格式 | Kong 消费者 | RLS |
|------|------|------------|-----|
| Anon（公开） | `sb_publishable_{32字符}` | `{ref}--anon` | 受约束 |
| Service Role（服务端） | `sb_secret_{32字符}` | `{ref}--service_role` | 绕过 |

### 安全须知

- **切勿将 `sb_secret_*` 暴露**在客户端代码或公开仓库中
- Anon 密钥可安全用于客户端 — 受 RLS 策略约束
- Kong 铸造的短效 JWT 有效期仅 5 分钟，最大限度减少重放窗口
- 所有 RDS 连接均使用 SSL 加密

---

## 快速参考

```bash
# 构建全部镜像
./build-and-push.sh

# 部署基础设施
cd infra && npm run build && npx cdk deploy SupabaseStack --require-approval never

# 初始化首个项目
./scripts/provision-worker-and-create-project.sh

# 运行测试
cd tests && pip install -r requirements.txt && ./RUN_TESTS.sh

# 获取 API 密钥
curl -sk "https://${STUDIO_ALB}/api/v1/projects/${PROJECT_REF}/api-keys" | jq .

# SDK 查询
curl -sk -H "apikey: ${KEY}" -H "Authorization: Bearer ${KEY}" \
  "https://${PROJECT_REF}.${DOMAIN}/rest/v1/table?select=*" | jq .

# 查看服务状态
aws ecs describe-services --cluster infrastack-cluster \
  --services kong-gateway tenant-manager studio functions-service function-deploy postgres-meta \
  --region ${AWS_REGION} --query 'services[*].[serviceName,runningCount,desiredCount]' --output table

# 查看日志
aws logs tail /ecs/supabase --since 10m --region ${AWS_REGION}
```
