# 多租户项目创建功能实现计划

## 概述

在 Supabase apps 项目中实现多租户项目创建功能，采用前后端分离架构：
- **后端**：独立的 Tenant Manager Service
- **前端**：在 Studio 中扩展管理界面
- **SDK**：直接调用 Admin Service API

---

## 架构设计

```
┌─────────────────┐     ┌─────────────────┐
│  Studio 前端    │     │    SDK/CLI      │
│  (管理界面)     │     │  (程序化调用)   │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │  Tenant Manager       │
         │  Service (Node.js)    │
         │  /admin/v1/projects   │
         └───────────┬───────────┘
                     │
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
┌─────────┐   ┌───────────┐   ┌───────────┐
│ RDS 集群 │   │ DynamoDB  │   │ Secrets   │
│         │   │           │   │ Manager   │
└─────────┘   └───────────┘   └───────────┘
```

---

## 第一部分：Tenant Manager Service（后端）

### 1.1 项目结构

```
apps/tenant-manager/
├── src/
│   ├── index.ts                    # 入口文件
│   ├── config/
│   │   └── index.ts               # 环境变量配置
│   ├── routes/
│   │   ├── index.ts               # 路由汇总
│   │   ├── projects.ts            # 项目 CRUD API
│   │   ├── health.ts              # 健康检查
│   │   └── admin.ts               # 管理端点
│   ├── services/
│   │   ├── project-service.ts     # 项目服务（迁移自 Studio）
│   │   ├── rds-balancer.ts        # RDS 负载均衡
│   │   ├── schema-initializer.ts  # Schema 初始化
│   │   ├── key-generator.ts       # 密钥生成
│   │   └── verifier.ts            # 项目验证
│   ├── aws/
│   │   ├── secrets-manager.ts     # AWS Secrets Manager
│   │   ├── dynamodb.ts            # DynamoDB 操作
│   │   └── rds.ts                 # RDS 实例管理
│   ├── db/
│   │   ├── postgres.ts            # PostgreSQL 连接池
│   │   └── queries.ts             # SQL 查询
│   ├── middleware/
│   │   ├── auth.ts                # 认证中间件
│   │   └── validation.ts          # 参数验证
│   └── types/
│       └── index.ts               # 类型定义
├── package.json
├── tsconfig.json
└── Dockerfile
```

### 1.2 API 端点设计（与官方 Management API 兼容）

**核心项目端点**（与官方格式一致）：

| 方法 | 端点 | 描述 |
|------|------|------|
| POST | `/admin/v1/projects` | 创建项目 |
| GET | `/admin/v1/projects` | 列出所有项目（分页） |
| GET | `/admin/v1/projects/{ref}` | 获取项目详情 |
| PATCH | `/admin/v1/projects/{ref}` | 更新项目 |
| DELETE | `/admin/v1/projects/{ref}` | 删除项目 |
| POST | `/admin/v1/projects/{ref}/pause` | 暂停项目 |
| POST | `/admin/v1/projects/{ref}/restore` | 恢复项目 |
| GET | `/admin/v1/projects/{ref}/health` | 健康检查 |

**RDS 实例管理端点**：

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | `/admin/v1/rds-instances` | 列出所有 RDS 实例 |
| POST | `/admin/v1/rds-instances` | 添加新 RDS 实例 |
| GET | `/admin/v1/rds-instances/{id}` | 获取 RDS 实例详情 |
| PATCH | `/admin/v1/rds-instances/{id}` | 更新 RDS 实例配置 |
| DELETE | `/admin/v1/rds-instances/{id}` | 移除 RDS 实例 |
| GET | `/admin/v1/rds-instances/{id}/metrics` | RDS 实例指标 |
| GET | `/admin/v1/rds-instances/{id}/projects` | 实例上的项目列表 |
| POST | `/admin/v1/rds-instances/{id}/drain` | 设置实例为 draining（停止分配新项目）|

### 1.3 请求/响应格式（与官方兼容）

**创建项目请求**：
```typescript
interface CreateProjectRequest {
  name: string                           // 项目名称
  organization_id?: number               // 组织 ID
  db_pass?: string                       // 数据库密码（可选，自动生成）
  db_region?: string                     // 区域（系统自动选择该区域负载最低的 RDS）
  desired_instance_size?: InstanceSize   // 实例大小
  postgres_engine?: '15' | '17'          // PG 版本
  admin_email?: string                   // 管理员邮箱
  plan?: 'free' | 'pro' | 'team'         // 计划类型
}
// 注意：RDS 实例由系统自动选择，不支持手动指定
```

**创建项目响应**（与官方格式一致）：
```typescript
interface CreateProjectResponse {
  id: number
  ref: string                            // 项目引用 ID
  name: string
  organization_id: number
  cloud_provider: string
  region: string
  status: ProjectStatus
  endpoint: string                       // API 端点 URL
  anon_key: string                       // 匿名密钥
  service_key: string                    // 服务角色密钥
  inserted_at: string
  // 多租户扩展字段
  db_instance_id: number                 // 所在 RDS 实例
  schema_name: string                    // Schema 名称
}
```

**项目状态枚举**（与官方一致）：
```typescript
type ProjectStatus =
  | 'ACTIVE_HEALTHY'
  | 'COMING_UP'
  | 'GOING_DOWN'
  | 'INACTIVE'
  | 'INIT_FAILED'
  | 'REMOVED'
  | 'RESTORING'
  | 'PAUSING'
  | 'PAUSED'
  | 'RESTARTING'
```

**分页响应格式**（与官方一致）：
```typescript
interface ListProjectsResponse {
  pagination: {
    count: number
    limit: number
    offset: number
  }
  projects: Project[]
}
```

### 1.4 RDS 实例管理格式

**添加 RDS 实例请求**：
```typescript
interface AddRdsInstanceRequest {
  identifier: string               // 实例标识符（如 rds-prod-01）
  name: string                     // 显示名称
  host: string                     // 主机地址
  port: number                     // 端口（默认 5432）
  admin_user: string               // 管理员用户名
  admin_password: string           // 管理员密码（将加密存储）
  region: string                   // 区域
  max_databases: number            // 最大数据库/Schema 数量
  weight?: number                  // 权重（用于加权随机选择，默认 1）
}
```

**RDS 实例响应**：
```typescript
interface RdsInstance {
  id: number
  identifier: string
  name: string
  host: string
  port: number
  region: string
  status: 'active' | 'draining' | 'maintenance' | 'offline'
  max_databases: number
  current_databases: number        // 当前项目数
  weight: number
  created_at: string
  updated_at: string
  // 指标（可选，通过 /metrics 端点获取详细信息）
  metrics?: {
    cpu_usage: number
    connection_count: number
    storage_used_gb: number
  }
}
```

**设置 Draining 状态**：
```typescript
// POST /admin/v1/rds-instances/{id}/drain
// 将实例设置为 draining 状态，系统不再分配新项目到该实例
// 用于计划下线或维护 RDS 实例
interface DrainResponse {
  id: number
  status: 'draining'
  projects_count: number           // 该实例上仍有的项目数
  message: string                  // 提示信息
}
```

### 1.5 RDS 自动选择逻辑（全自动，用户无法手动指定）

**选择策略**：
```typescript
type InstanceSelectionStrategy =
  | 'least_projects'      // 项目数最少（默认）
  | 'least_connections'   // 连接数最少
  | 'weighted_random'     // 加权随机
  | 'region_affinity'     // 区域亲和（优先选择与请求区域相同的 RDS）
```

**负载评分算法**：
```javascript
calculateScore({ schemaCount, cpuUsage, connectionCount, maxSchemas }) {
  return (
    (schemaCount / maxSchemas) * 0.4 +        // Schema 数量 40%
    (cpuUsage / 100) * 0.3 +                  // CPU 使用率 30%
    (connectionCount / 500) * 0.2 +           // 连接数 20%
    (1 - (maxSchemas - schemaCount) / maxSchemas) * 0.1
  )
}
```

**工作流程**：
1. 创建项目时，系统自动查询所有 `status: 'active'` 的 RDS 实例
2. 排除 `status: 'draining'` 或 `status: 'offline'` 的实例
3. 如果指定了 `db_region`，优先选择该区域的 RDS
4. 使用负载评分算法选择分数最低的实例
5. 将项目分配到选中的 RDS

### 1.6 从 Studio 迁移的核心逻辑

**源文件位置**（Studio）:
- `lib/api/self-hosted/multi-tenant/transaction-manager.ts` → 项目创建/删除事务
- `lib/api/self-hosted/multi-tenant/database-provisioner.ts` → 数据库创建/初始化
- `lib/api/self-hosted/multi-tenant/crypto.ts` → 密钥生成
- `lib/api/self-hosted/multi-tenant/services/` → 服务注册（Auth, Realtime, Supavisor）
- `lib/api/self-hosted/multi-tenant/types.ts` → 类型定义

**迁移后增强**:
1. 添加 AWS Secrets Manager 集成
2. 添加 DynamoDB 映射表操作
3. 添加 RDS 负载均衡选择
4. 添加参数验证（邮箱、配额）
5. 增强回滚机制（包含 AWS 资源清理）

### 1.7 项目创建流程

```
1. 验证参数
   - 检查 project_id 唯一性
   - 验证 admin_email 格式
   - 检查配额限制

2. 选择 RDS 实例
   - 查询所有 RDS 负载情况
   - 使用负载均衡算法选择最佳实例

3. 创建 Schema
   - 在选定 RDS 中创建 project_xxx schema
   - 创建基础表结构
   - 设置 RLS 策略

4. 生成密钥
   - jwt_secret, anon_key, service_role_key
   - 数据库密码

5. 存储密钥
   - AWS Secrets Manager

6. 更新映射
   - DynamoDB project-rds-mapping

7. 注册服务
   - GoTrue (Auth)
   - Realtime
   - Supavisor

8. 验证创建
   - 测试端点可用性

9. 返回结果
   - project_id, endpoint, API keys
```

### 1.8 关键实现文件

**project-service.ts** - 核心服务
```typescript
// 主要方法
export class ProjectService {
  async createProject(input: CreateProjectInput): Promise<CreateProjectResponse>
  async deleteProject(projectId: string): Promise<void>
  async getProject(projectId: string): Promise<Project>
  async listProjects(options: ListOptions): Promise<Project[]>
  async pauseProject(projectId: string): Promise<void>
  async resumeProject(projectId: string): Promise<void>
}
```

**rds-balancer.ts** - RDS 负载均衡
```typescript
export class RDSBalancer {
  async selectBestInstance(options?: SelectionOptions): Promise<RDSInstance>
  async getInstanceMetrics(instanceId: string): Promise<InstanceMetrics>
}
```

---

## 第二部分：Studio 前端扩展

### 2.1 新增页面

| 路径 | 描述 |
|------|------|
| `/admin/projects` | 项目列表（管理员视图） |
| `/admin/projects/new` | 创建项目 |
| `/admin/projects/[ref]` | 项目详情 |
| `/admin/rds-instances` | RDS 实例管理 |

### 2.2 新增组件

```
components/interfaces/Admin/
├── ProjectList/
│   ├── AdminProjectList.tsx       # 项目列表
│   ├── AdminProjectRow.tsx        # 项目行
│   └── ProjectStatusBadge.tsx     # 状态徽章
├── ProjectCreation/
│   ├── AdminProjectForm.tsx       # 创建表单（不含 RDS 选择，系统自动分配）
│   └── ProjectQuotaInput.tsx      # 配额设置
└── RdsInstances/
    ├── RdsInstanceList.tsx        # RDS 实例列表
    ├── RdsInstanceMetrics.tsx     # 指标显示
    ├── AddRdsInstanceForm.tsx     # 添加新 RDS 实例表单
    └── RdsInstanceActions.tsx     # 实例操作（drain、删除等）
```

### 2.3 数据层

```
data/admin/
├── projects/
│   ├── admin-projects-query.ts        # 项目列表查询
│   ├── admin-project-create-mutation.ts # 创建项目
│   └── admin-project-delete-mutation.ts # 删除项目
├── rds-instances/
│   ├── rds-instances-query.ts         # RDS 实例列表查询
│   ├── rds-instance-add-mutation.ts   # 添加 RDS 实例
│   ├── rds-instance-update-mutation.ts # 更新 RDS 实例
│   ├── rds-instance-delete-mutation.ts # 删除 RDS 实例
│   ├── rds-instance-drain-mutation.ts # 设置 draining 状态
│   └── rds-instance-metrics-query.ts  # RDS 指标查询
└── types.ts                           # 类型定义
```

### 2.4 可复用的现有组件

从 `components/interfaces/ProjectCreation/` 复用：
- `ProjectNameInput.tsx`
- `RegionSelector.tsx`
- `DatabasePasswordInput.tsx`
- `OrganizationSelector.tsx`
- `SecurityOptions.tsx`

---

## 第三部分：SDK 设计

### 3.1 SDK 结构

```typescript
// @supabase/admin-sdk
import { AdminClient } from '@supabase/admin-sdk'

const admin = new AdminClient({
  endpoint: 'https://admin.example.com',
  apiKey: 'your-admin-api-key'
})

// 创建项目
const project = await admin.projects.create({
  name: 'my-project',
  region: 'us-east-1',
  plan: 'pro'
})

// 列出项目
const projects = await admin.projects.list()

// 删除项目
await admin.projects.delete('project-id')
```

---

## 实施步骤

### Phase 1: Tenant Manager Service 基础

1. 初始化项目结构 (`apps/tenant-manager/`)
2. 配置 TypeScript、ESLint、环境变量
3. 实现 Express/Fastify 路由框架
4. 迁移 `transaction-manager.ts` 逻辑
5. 迁移 `database-provisioner.ts` 逻辑
6. 迁移 `crypto.ts` 密钥生成逻辑

### Phase 2: AWS 集成

1. 实现 Secrets Manager 模块
2. 实现 DynamoDB 映射操作
3. 实现 RDS 负载均衡器
4. 添加 CloudWatch 指标获取

### Phase 3: API 完善

1. 实现所有 CRUD 端点
2. 添加认证中间件
3. 添加参数验证
4. 实现回滚机制
5. 添加健康检查端点

### Phase 4: Studio 前端

1. 创建 Admin 布局和导航
2. 实现项目列表页面
3. 实现项目创建表单
4. 实现 RDS 实例管理页面
5. 连接数据层到 Admin Service

### Phase 5: 测试与部署

1. 单元测试
2. 集成测试
3. Docker 镜像构建
4. ECS 部署配置
5. 文档编写

---

## 环境变量

### Tenant Manager Service

```bash
# 服务配置
PORT=3001
NODE_ENV=production

# AWS 配置
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx

# Secrets Manager
AWS_SECRETS_PREFIX=supabase/projects

# DynamoDB
DYNAMODB_TABLE_PROJECT_MAPPING=project-rds-mapping

# 默认 RDS
RDS_DEFAULT_INSTANCE_ID=1

# 认证
ADMIN_API_KEY=xxx
JWT_SECRET=xxx

# 服务注册
GOTRUE_URL=http://gotrue:9999
REALTIME_URL=http://realtime:4000
SUPAVISOR_URL=http://supavisor:4000
```

### Studio

```bash
# Admin Service 配置
NEXT_PUBLIC_ADMIN_SERVICE_URL=https://admin.example.com
ADMIN_SERVICE_API_KEY=xxx
```

---

## 关键文件路径

### 需要迁移的源文件（Studio）

- `/apps/studio/lib/api/self-hosted/multi-tenant/transaction-manager.ts`
- `/apps/studio/lib/api/self-hosted/multi-tenant/database-provisioner.ts`
- `/apps/studio/lib/api/self-hosted/multi-tenant/crypto.ts`
- `/apps/studio/lib/api/self-hosted/multi-tenant/types.ts`
- `/apps/studio/lib/api/self-hosted/multi-tenant/services/auth.ts`
- `/apps/studio/lib/api/self-hosted/multi-tenant/services/realtime.ts`
- `/apps/studio/lib/api/self-hosted/multi-tenant/services/supavisor.ts`

### 可复用的前端组件（Studio）

- `/apps/studio/components/interfaces/ProjectCreation/ProjectNameInput.tsx`
- `/apps/studio/components/interfaces/ProjectCreation/RegionSelector.tsx`
- `/apps/studio/components/interfaces/ProjectCreation/DatabasePasswordInput.tsx`
- `/apps/studio/components/interfaces/ProjectCreation/OrganizationSelector.tsx`

---

## 验证方案

1. **单元测试**: 各服务模块的独立测试
2. **集成测试**: 完整项目创建流程测试
3. **端到端测试**:
   - 通过 SDK 创建项目
   - 验证数据库可访问
   - 验证 API keys 有效
   - 验证服务注册成功
4. **回滚测试**: 模拟失败场景验证回滚完整性
