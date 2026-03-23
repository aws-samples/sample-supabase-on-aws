# Supabase-on-AWS 完整架构图

> 本文档从多个角度详细展示 Supabase-on-AWS 项目的架构设计

## 目录
1. [总体系统架构](#1-总体系统架构)
2. [网络与基础设施架构](#2-网络与基础设施架构)
3. [请求流程架构](#3-请求流程架构)
4. [数据流架构](#4-数据流架构)
5. [服务组件架构](#5-服务组件架构)
6. [安全架构](#6-安全架构)
7. [部署架构](#7-部署架构)

---

## 1. 总体系统架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Supabase-on-AWS Platform                            │
│                         Multi-Tenant SaaS Architecture                       │
└─────────────────────────────────────────────────────────────────────────────┘

                                    Internet
                                       │
                                       ▼
                    ┌──────────────────────────────────┐
                    │   Route 53 DNS                   │
                    │   *.example.com               │
                    │   - api.example.com           │
                    │   - studio.example.com        │
                    │   - {project}.example.com     │
                    └──────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              AWS Cloud (us-east-1)                            │
│  Account: <AWS_ACCOUNT_ID>                                                        │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        Application Load Balancers                    │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │    │
│  │  │  Kong ALB    │  │ Studio ALB   │  │ Tenant Mgr   │              │    │
│  │  │  (API GW)    │  │              │  │    ALB       │              │    │
│  │  │  Port 443    │  │  Port 443    │  │  Port 443    │              │    │
│  │  │  ACM Cert    │  │  ACM Cert    │  │  ACM Cert    │              │    │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │    │
│  └─────────┼──────────────────┼──────────────────┼──────────────────────┘    │
│            │                  │                  │                           │
│  ┌─────────┼──────────────────┼──────────────────┼──────────────────────┐    │
│  │         │      VPC (2 AZs, 1 NAT Gateway)     │                      │    │
│  │         │                  │                  │                      │    │
│  │  ┌──────▼──────────────────▼──────────────────▼──────────────────┐  │    │
│  │  │              ECS Fargate Cluster (<ECS_CLUSTER>)         │  │    │
│  │  │                                                                │  │    │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │  │    │
│  │  │  │   Kong      │  │   Studio    │  │   Tenant    │           │  │    │
│  │  │  │  Gateway    │  │   Service   │  │   Manager   │           │  │    │
│  │  │  │  (DB Mode)  │  │             │  │             │           │  │    │
│  │  │  │  512CPU     │  │  512CPU     │  │  512CPU     │           │  │    │
│  │  │  │  1024MB     │  │  1024MB     │  │  1024MB     │           │  │    │
│  │  │  └─────┬───────┘  └─────┬───────┘  └─────┬───────┘           │  │    │
│  │  │        │                 │                 │                   │  │    │
│  │  │  ┌─────▼─────────────────▼─────────────────▼───────┐          │  │    │
│  │  │  │         Functions Service (Edge Functions)      │          │  │    │
│  │  │  │         256CPU / 512MB                           │          │  │    │
│  │  │  └──────────────────────────────────────────────────┘          │  │    │
│  │  └────────────────────────────────────────────────────────────────┘  │    │
│  │                                                                       │    │
│  │  ┌────────────────────────────────────────────────────────────────┐  │    │
│  │  │              Lambda Functions (Per-Tenant)                     │  │    │
│  │  │                                                                │  │    │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │  │    │
│  │  │  │  PostgREST   │  │  PostgREST   │  │  PostgREST   │        │  │    │
│  │  │  │  Lambda      │  │  Lambda      │  │  Lambda      │        │  │    │
│  │  │  │  (Project-A) │  │  (Project-B) │  │  (Project-N) │        │  │    │
│  │  │  │  512MB       │  │  512MB       │  │  512MB       │        │  │    │
│  │  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │  │    │
│  │  └─────────┼──────────────────┼──────────────────┼───────────────┘  │    │
│  │            │                  │                  │                  │    │
│  │  ┌─────────┼──────────────────┼──────────────────┼───────────────┐  │    │
│  │  │         │      Data Layer                     │               │  │    │
│  │  │         │                                     │               │  │    │
│  │  │  ┌──────▼──────────────────────────────────────▼──────────┐   │  │    │
│  │  │  │         RDS PostgreSQL (Primary Instance)             │   │  │    │
│  │  │  │         db.t3.micro / PostgreSQL 16.6                 │   │  │    │
│  │  │  │                                                        │   │  │    │
│  │  │  │  ┌──────────────┐  ┌──────────────┐                  │   │  │    │
│  │  │  │  │  kong DB     │  │  supabase_   │                  │   │  │    │
│  │  │  │  │  (Kong       │  │  platform    │                  │   │  │    │
│  │  │  │  │   Config)    │  │  (Projects)  │                  │   │  │    │
│  │  │  │  └──────────────┘  └──────────────┘                  │   │  │    │
│  │  │  └───────────────────────────────────────────────────────┘   │  │    │
│  │  │                                                               │  │    │
│  │  │  ┌───────────────────────────────────────────────────────┐   │  │    │
│  │  │  │      RDS PostgreSQL (Worker Instance)                 │   │  │    │
│  │  │  │      supabase-worker-01 / db.t3.micro                 │   │  │    │
│  │  │  │                                                        │   │  │    │
│  │  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐            │   │  │    │
│  │  │  │  │ Tenant   │  │ Tenant   │  │ Tenant   │            │   │  │    │
│  │  │  │  │ DB-A     │  │ DB-B     │  │ DB-N     │            │   │  │    │
│  │  │  │  │ (supabase│  │ (supabase│  │ (supabase│            │   │  │    │
│  │  │  │  │  schema)  │  │  schema)  │  │  schema)  │            │   │  │    │
│  │  │  │  └──────────┘  └──────────┘  └──────────┘            │   │  │    │
│  │  │  └───────────────────────────────────────────────────────┘   │  │    │
│  │  │                                                               │  │    │
│  │  │  ┌───────────────────────────────────────────────────────┐   │  │    │
│  │  │  │      ElastiCache Redis (kong-cache)                   │   │  │    │
│  │  │  │      cache.t3.micro                                   │   │  │    │
│  │  │  │      - JWT secrets cache (TTL: 300s)                  │   │  │    │
│  │  │  │      - Lambda function URLs cache                     │   │  │    │
│  │  │  └───────────────────────────────────────────────────────┘   │  │    │
│  │  └───────────────────────────────────────────────────────────────┘  │    │
│  │                                                                       │    │
│  │  ┌────────────────────────────────────────────────────────────────┐  │    │
│  │  │              Supporting Services                               │  │    │
│  │  │                                                                │  │    │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │  │    │
│  │  │  │   Secrets    │  │   ECR        │  │   CloudWatch │        │  │    │
│  │  │  │   Manager    │  │   (Docker    │  │   Logs       │        │  │    │
│  │  │  │              │  │   Registry)  │  │              │        │  │    │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘        │  │    │
│  │  └────────────────────────────────────────────────────────────────┘  │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────┐
                    │   Client Applications            │
                    │   - Supabase JS SDK              │
                    │   - Supabase Python SDK          │
                    │   - Direct REST API              │
                    │   - Studio Web UI                │
                    └──────────────────────────────────┘
```

### 架构特点

1. **多租户隔离**：每个项目拥有独立的 Lambda 函数和数据库
2. **API Gateway 模式**：Kong 作为统一入口，处理认证、路由、JWT 铸造
3. **动态扩展**：基于 ECS Fargate 和 Lambda 的无服务器架构
4. **高可用性**：跨 2 个可用区部署，ALB 自动故障转移
5. **安全隔离**：VPC 内部通信，安全组严格控制访问

---

## 2. 网络与基础设施架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          VPC Network Architecture                            │
│                          CIDR: 10.0.0.0/16 (2 AZs)                          │
└─────────────────────────────────────────────────────────────────────────────┘

                              Internet Gateway
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
              ┌─────▼─────┐    ┌─────▼─────┐   ┌─────▼─────┐
              │  ALB SG   │    │  ALB SG   │   │  ALB SG   │
              │ (Kong)    │    │ (Studio)  │   │ (Tenant)  │
              │ 0.0.0.0   │    │ 0.0.0.0   │   │ 0.0.0.0   │
              │ :443      │    │ :443      │   │ :443      │
              └─────┬─────┘    └─────┬─────┘   └─────┬─────┘
                    │                │                │
┌───────────────────┼────────────────┼────────────────┼───────────────────────┐
│  Public Subnet    │                │                │                       │
│  (AZ-1)           │                │                │                       │
│  10.0.0.0/24      │                │                │                       │
└───────────────────┼────────────────┼────────────────┼───────────────────────┘
                    │                │                │
                    │         NAT Gateway (AZ-1)      │
                    │                │                │
┌───────────────────┼────────────────┼────────────────┼───────────────────────┐
│  Private Subnet   │                │                │                       │
│  (AZ-1)           │                │                │                       │
│  10.0.1.0/24      │                │                │                       │
│                   │                │                │                       │
│  ┌────────────────▼────────────────▼────────────────▼────────────────┐     │
│  │                    ECS Fargate Tasks                              │     │
│  │                                                                   │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │     │
│  │  │  Kong SG     │  │  Studio SG   │  │  Tenant SG   │           │     │
│  │  │  ALBSG:8000  │  │  ALBSG:8000  │  │  ALBSG:8080  │           │     │
│  │  │  TenantSG:   │  │              │  │  KongSG:8080 │           │     │
│  │  │    8001      │  │              │  │  LambdaSG:   │           │     │
│  │  │              │  │              │  │    8080      │           │     │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │     │
│  └─────────┼──────────────────┼──────────────────┼───────────────────┘     │
│            │                  │                  │                         │
│  ┌─────────▼──────────────────▼──────────────────▼───────────────────┐    │
│  │                    Lambda Functions (VPC)                          │    │
│  │                                                                    │    │
│  │  ┌──────────────────────────────────────────────────────────┐     │    │
│  │  │  Lambda SG                                               │     │    │
│  │  │  - Outbound to RDS:5432                                  │     │    │
│  │  │  - Outbound to TenantMgr:8080                            │     │    │
│  │  └──────────────────────────────────────────────────────────┘     │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │                    Data Layer                                    │     │
│  │                                                                  │     │
│  │  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐    │     │
│  │  │  RDS SG        │  │  RDS SG        │  │  Redis SG      │    │     │
│  │  │  LambdaSG:5432 │  │  LambdaSG:5432 │  │  KongSG:6379   │    │     │
│  │  │  KongSG:5432   │  │  TenantSG:5432 │  │                │    │     │
│  │  │  TenantSG:5432 │  │                │  │                │    │     │
│  │  │                │  │                │  │                │    │     │
│  │  │  Primary RDS   │  │  Worker RDS    │  │  ElastiCache   │    │     │
│  │  │  (Platform)    │  │  (Tenants)     │  │  Redis         │    │     │
│  │  └────────────────┘  └────────────────┘  └────────────────┘    │     │
│  └──────────────────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│  Public Subnet (AZ-2) - 10.0.2.0/24                                       │
│  Private Subnet (AZ-2) - 10.0.3.0/24                                      │
│  (Similar layout for high availability)                                   │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│                      Security Group Rules Summary                          │
├───────────────────────────────────────────────────────────────────────────┤
│  ALBSG (sg-<ALBSG>)                                             │
│    Inbound: 0.0.0.0/0:443 (HTTPS from Internet)                           │
│    Outbound: KongSG:8000, StudioSG:8000, TenantSG:8080                    │
├───────────────────────────────────────────────────────────────────────────┤
│  KongSG (sg-<KongSG>)                                            │
│    Inbound: ALBSG:8000, TenantSG:8001                                     │
│    Outbound: RDS:5432, Redis:6379, TenantSG:8080, FunctionsSG:8080       │
├───────────────────────────────────────────────────────────────────────────┤
│  TenantManagerSG (sg-<TenantManagerSG>)                                   │
│    Inbound: KongSG:8080, LambdaSG:8080, ALBSG:8080                        │
│    Outbound: RDS:5432, Kong:8001                                          │
├───────────────────────────────────────────────────────────────────────────┤
│  LambdaSG (sg-<LambdaSG>)                                          │
│    Inbound: None                                                          │
│    Outbound: RDS:5432, TenantMgr:8080                                     │
├───────────────────────────────────────────────────────────────────────────┤
│  RdsSG (sg-<RdsSG>)                                             │
│    Inbound: LambdaSG:5432, KongSG:5432, TenantSG:5432                     │
│    Outbound: None                                                         │
├───────────────────────────────────────────────────────────────────────────┤
│  RedisSG (sg-<RedisSG>)                                           │
│    Inbound: KongSG:6379                                                   │
│    Outbound: None                                                         │
└───────────────────────────────────────────────────────────────────────────┘
```

### 网络设计要点

1. **多层安全**：公有子网（ALB）→ 私有子网（应用）→ 数据层（RDS/Redis）
2. **最小权限**：安全组严格限制端口和来源
3. **高可用**：跨 2 个 AZ 部署，单 NAT Gateway（成本优化）
4. **服务发现**：AWS Cloud Map (kong.local 命名空间)
5. **SSL 加密**：所有 RDS 连接强制 SSL


---

## 3. 请求流程架构（Gateway JWT Minting）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Client Request Flow (Gateway JWT Minting)                 │
│                    Pattern: Opaque API Key → Short-lived JWT                 │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐
│  Client App      │
│  (Supabase SDK)  │
└────────┬─────────┘
         │
         │ 1. HTTP Request
         │    GET https://project-alpha.example.com/rest/v1/users
         │    Authorization: Bearer sb_publishable_abc123xyz...
         │    (SDK 自动添加 API key 作为 Bearer token)
         │
         ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  ALB (Application Load Balancer)                                           │
│  - SSL Termination (ACM Certificate)                                       │
│  - Health Check: /health                                                   │
└────────┬───────────────────────────────────────────────────────────────────┘
         │
         │ 2. Forward to Kong
         │    Host: project-alpha.example.com
         │    Authorization: Bearer sb_publishable_abc123xyz...
         │
         ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Kong Gateway (ECS Fargate)                                                │
│  DB-backed mode with PostgreSQL                                            │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Plugin Chain (按优先级执行)                                          │ │
│  │                                                                        │ │
│  │  ┌────────────────────────────────────────────────────────────────┐  │ │
│  │  │  1. pre-function (Priority: 1000000)                           │  │ │
│  │  │     - 从 Host header 提取子域名                                 │  │ │
│  │  │     - Host: project-alpha.example.com                       │  │ │
│  │  │     - 提取: "project-alpha"                                     │  │ │
│  │  │     - 设置: X-Project-ID: project-alpha                        │  │ │
│  │  └────────────────────────────────────────────────────────────────┘  │ │
│  │                          │                                            │ │
│  │  ┌────────────────────────▼────────────────────────────────────────┐  │ │
│  │  │  2. key-auth (Priority: 1003)                                   │  │ │
│  │  │     - 从 Authorization header 提取 API key                      │  │ │
│  │  │     - 查询 Kong DB: consumers 表                                │  │ │
│  │  │     - 匹配 consumer: "project-alpha--anon"                      │  │ │
│  │  │     - 验证成功后移除 Authorization header                       │  │ │
│  │  │       (hide_credentials: true)                                  │  │ │
│  │  │     - 设置 kong.client.authenticated_consumer                   │  │ │
│  │  └────────────────────────────────────────────────────────────────┘  │ │
│  │                          │                                            │ │
│  │  ┌────────────────────────▼────────────────────────────────────────┐  │ │
│  │  │  3. dynamic-lambda-router (Priority: 1001)                      │  │ │
│  │  │                                                                  │  │ │
│  │  │  Step 1: 解析角色                                                │  │ │
│  │  │    consumer = kong.client.get_consumer()                        │  │ │
│  │  │    username = "project-alpha--anon"                             │  │ │
│  │  │    role = "anon"  (从 username 解析)                            │  │ │
│  │  │                                                                  │  │ │
│  │  │  Step 2: 获取 JWT Secret (Redis Cache)                          │  │ │
│  │  │    cache_key = "jwt:secret:project-alpha"                       │  │ │
│  │  │    jwt_secret = redis:get(cache_key)                            │  │ │
│  │  │    if not found:                                                │  │ │
│  │  │      GET http://tenant-manager:8080/project/project-alpha/config│  │ │
│  │  │      response: {project_id, function_url, jwt_secret}           │  │ │
│  │  │      redis:setex(cache_key, 300, jwt_secret)                    │  │ │
│  │  │                                                                  │  │ │
│  │  │  Step 3: 铸造短期 JWT (5分钟有效期)                              │  │ │
│  │  │    payload = {                                                  │  │ │
│  │  │      iss: "supabase",                                           │  │ │
│  │  │      ref: "project-alpha",                                      │  │ │
│  │  │      role: "anon",                                              │  │ │
│  │  │      iat: now(),                                                │  │ │
│  │  │      exp: now() + 300  // 5 minutes                             │  │ │
│  │  │    }                                                            │  │ │
│  │  │    jwt = HS256_sign(payload, jwt_secret)                        │  │ │
│  │  │                                                                  │  │ │
│  │  │  Step 4: 获取 Lambda Function URL (Redis Cache)                 │  │ │
│  │  │    cache_key = "lambda:fn:project-alpha"                        │  │ │
│  │  │    function_url = redis:get(cache_key)                          │  │ │
│  │  │    if not found: (从 Step 2 的 API 响应获取)                    │  │ │
│  │  │      redis:setex(cache_key, 300, function_url)                  │  │ │
│  │  │                                                                  │  │ │
│  │  │  Step 5: SigV4 签名并调用 Lambda                                │  │ │
│  │  │    headers = {                                                  │  │ │
│  │  │      "X-Client-Authorization": "Bearer " .. jwt,               │  │ │
│  │  │      "Authorization": <SigV4 signature>                         │  │ │
│  │  │    }                                                            │  │ │
│  │  │    response = http.post(function_url, headers, body)            │  │ │
│  │  │                                                                  │  │ │
│  │  │  Step 6: 返回响应 (短路，不继续执行后续插件)                     │  │ │
│  │  │    kong.response.exit(response.status, response.body)           │  │ │
│  │  └────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                        │ │
│  │  ┌────────────────────────────────────────────────────────────────┐  │ │
│  │  │  4. ACL (Priority: 950) - 不会执行                              │  │ │
│  │  │     因为 dynamic-lambda-router 已经短路返回                      │  │ │
│  │  └────────────────────────────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└────────┬───────────────────────────────────────────────────────────────────┘
         │
         │ 3. Lambda Invocation (Function URL + SigV4)
         │    POST https://abc123.lambda-url.us-east-1.on.aws/
         │    X-Client-Authorization: Bearer eyJhbGc...  (短期 JWT)
         │    Authorization: AWS4-HMAC-SHA256 ...  (SigV4)
         │
         ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Lambda Function (PostgREST)                                               │
│  Function Name: postgrest-project-alpha                                    │
│  Memory: 512MB, VPC-enabled                                                │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Lambda Web Adapter (LWA)                                            │ │
│  │  - 拦截请求                                                           │ │
│  │  - X-Client-Authorization → Authorization                            │ │
│  │  - 转发给 PostgREST                                                   │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                          │                                                │
│  ┌────────────────────────▼────────────────────────────────────────────┐  │
│  │  PostgREST Process                                                   │  │
│  │                                                                      │  │
│  │  1. 验证 JWT                                                         │  │
│  │     - 从 Authorization header 提取 JWT                               │  │
│  │     - 使用 jwt_secret 验证签名                                       │  │
│  │     - 检查 exp (过期时间)                                            │  │
│  │     - 提取 role: "anon"                                              │  │
│  │                                                                      │  │
│  │  2. 设置 PostgreSQL 会话                                             │  │
│  │     SET LOCAL role TO 'anon';                                        │  │
│  │     SET LOCAL request.jwt.claims TO '{"role":"anon",...}';          │  │
│  │                                                                      │  │
│  │  3. 执行 SQL 查询                                                    │  │
│  │     SELECT * FROM users;                                             │  │
│  │     (受 RLS 策略约束)                                                │  │
│  │                                                                      │  │
│  │  4. 返回 JSON 响应                                                   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────┬───────────────────────────────────────────────────────────────────┘
         │
         │ 4. Database Query
         │    PostgreSQL connection with SSL
         │
         ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  RDS PostgreSQL (Worker Instance)                                          │
│  Database: supabase_project_alpha                                          │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Row Level Security (RLS) Enforcement                                │ │
│  │                                                                      │ │
│  │  CREATE POLICY "anon_select_policy" ON users                         │ │
│  │    FOR SELECT TO anon                                                │ │
│  │    USING (is_public = true);                                         │ │
│  │                                                                      │ │
│  │  Result: 只返回 is_public = true 的行                                │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└────────┬───────────────────────────────────────────────────────────────────┘
         │
         │ 5. Response (JSON)
         │    [{"id": 1, "name": "Alice", "is_public": true}, ...]
         │
         ▼
┌──────────────────┐
│  Client App      │
│  (Receives data) │
└──────────────────┘
```

### 请求流程关键点

1. **API Key 格式**：
   - Anon (可发布): `sb_publishable_{base64url_secret}`
   - Service Role (机密): `sb_secret_{base64url_secret}`

2. **Consumer 命名规则**：
   - `{project_id}--anon` (双破折号避免歧义)
   - `{project_id}--service_role`

3. **JWT 生命周期**：
   - 由 Kong 动态铸造，5分钟有效期
   - 限制重放攻击窗口（vs 10年静态 JWT）

4. **缓存策略**：
   - Redis 缓存 JWT secret 和 Lambda URL
   - TTL: 300秒
   - 缓存未命中时调用 tenant-manager API

5. **安全层次**：
   - Layer 1: ALB SSL 终止
   - Layer 2: Kong key-auth 验证
   - Layer 3: Lambda SigV4 签名
   - Layer 4: PostgREST JWT 验证
   - Layer 5: PostgreSQL RLS 策略


---

## 4. 数据流架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Data Flow Architecture                              │
│                   Platform Data vs Tenant Data Separation                    │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        Platform Control Plane                                 │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  RDS PostgreSQL (Primary Instance)                                     │  │
│  │  Endpoint: supabase-rds.xxx.us-east-1.rds.amazonaws.com               │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │  Database: kong                                                   │ │  │
│  │  │  Purpose: Kong Gateway 配置存储                                   │ │  │
│  │  │                                                                   │ │  │
│  │  │  Tables:                                                          │ │  │
│  │  │  ├─ consumers          (租户 consumer 注册)                       │ │  │
│  │  │  │   - id, username (project_id--role)                           │ │  │
│  │  │  │   - custom_id, created_at                                     │ │  │
│  │  │  │                                                               │ │  │
│  │  │  ├─ keyauth_credentials (API key 凭证)                           │ │  │
│  │  │  │   - id, consumer_id                                           │ │  │
│  │  │  │   - key (sb_publishable_xxx / sb_secret_xxx)                  │ │  │
│  │  │  │   - created_at                                                │ │  │
│  │  │  │                                                               │ │  │
│  │  │  ├─ acls               (访问控制列表)                            │ │  │
│  │  │  │   - id, consumer_id                                           │ │  │
│  │  │  │   - group (anon / admin)                                      │ │  │
│  │  │  │                                                               │ │  │
│  │  │  ├─ services           (后端服务定义)                            │ │  │
│  │  │  ├─ routes             (路由规则)                                │ │  │
│  │  │  └─ plugins            (插件配置)                                │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │  Database: supabase_platform                                      │ │  │
│  │  │  Purpose: 项目元数据和配置                                        │ │  │
│  │  │                                                                   │ │  │
│  │  │  Tables:                                                          │ │  │
│  │  │  ├─ projects                                                      │ │  │
│  │  │  │   - id (project_id)                                           │ │  │
│  │  │  │   - function_name (Lambda 函数名)                             │ │  │
│  │  │  │   - function_url (Lambda Function URL)                        │ │  │
│  │  │  │   - function_arn                                              │ │  │
│  │  │  │   - status (active/inactive)                                  │ │  │
│  │  │  │   - created_at                                                │ │  │
│  │  │  │                                                               │ │  │
│  │  │  ├─ api_keys                                                      │ │  │
│  │  │  │   - id (UUID)                                                 │ │  │
│  │  │  │   - project_id (FK → projects.id)                            │ │  │
│  │  │  │   - name (anon / service_role)                                │ │  │
│  │  │  │   - key_type (publishable / secret)                           │ │  │
│  │  │  │   - role (anon / service_role)                                │ │  │
│  │  │  │   - key_value (完整的 opaque key)                             │ │  │
│  │  │  │   - hashed_secret (SHA256 hash)                               │ │  │
│  │  │  │   - created_at                                                │ │  │
│  │  │  │                                                               │ │  │
│  │  │  ├─ jwt_keys                                                      │ │  │
│  │  │  │   - id (UUID)                                                 │ │  │
│  │  │  │   - project_id (FK → projects.id)                            │ │  │
│  │  │  │   - secret (JWT signing secret)                               │ │  │
│  │  │  │   - algorithm (HS256)                                         │ │  │
│  │  │  │   - status (current / rotated)                                │ │  │
│  │  │  │   - created_at, rotated_at                                    │ │  │
│  │  │  │                                                               │ │  │
│  │  │  └─ postgrest_config                                              │ │  │
│  │  │      - project_id (PK, FK → projects.id)                         │ │  │
│  │  │      - db_uri (租户数据库连接字符串)                              │ │  │
│  │  │      - db_schemas (public)                                        │ │  │
│  │  │      - db_anon_role (anon)                                        │ │  │
│  │  │      - db_use_legacy_gucs (false)                                 │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  ElastiCache Redis (kong-cache)                                        │  │
│  │  Endpoint: kong-cache.xxx.cache.amazonaws.com:6379                     │  │
│  │                                                                        │  │
│  │  Cache Keys:                                                           │  │
│  │  ├─ jwt:secret:{project_id}  → JWT signing secret (TTL: 300s)         │  │
│  │  └─ lambda:fn:{project_id}   → Lambda Function URL (TTL: 300s)        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  AWS Secrets Manager                                                    │  │
│  │  Purpose: 敏感凭证存储 (Legacy, 逐步迁移到 RDS)                         │  │
│  │                                                                        │  │
│  │  Secrets:                                                              │  │
│  │  ├─ postgrest/{project_id}/config                                      │  │
│  │  │   {                                                                │  │
│  │  │     "project_id": "...",                                           │  │
│  │  │     "jwt_secret": "...",                                           │  │
│  │  │     "anon_key": "eyJhbGc...",  (JWT format, legacy)                │  │
│  │  │     "service_role_key": "eyJhbGc..."  (JWT format, legacy)         │  │
│  │  │   }                                                                │  │
│  │  │                                                                    │  │
│  │  └─ rds-credentials                                                    │  │
│  │      - Master password for RDS instances                              │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                         Tenant Data Plane                                     │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  RDS PostgreSQL (Worker Instance)                                      │  │
│  │  Instance ID: supabase-worker-01                                       │  │
│  │  Endpoint: supabase-worker-01.xxx.us-east-1.rds.amazonaws.com         │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │  Database: supabase_project_alpha                                 │ │  │
│  │  │  Owner: project_alpha_owner                                       │ │  │
│  │  │                                                                   │ │  │
│  │  │  Schemas:                                                         │ │  │
│  │  │  ├─ public (应用数据)                                             │ │  │
│  │  │  │   - users, posts, comments, ...                               │ │  │
│  │  │  │   - 用户自定义表和数据                                         │ │  │
│  │  │  │                                                               │ │  │
│  │  │  ├─ auth (认证数据, 未来)                                         │ │  │
│  │  │  │   - users, sessions, refresh_tokens                           │ │  │
│  │  │  │                                                               │ │  │
│  │  │  └─ storage (存储元数据, 未来)                                    │ │  │
│  │  │      - buckets, objects                                          │ │  │
│  │  │                                                                   │ │  │
│  │  │  Roles:                                                           │ │  │
│  │  │  ├─ anon                                                          │ │  │
│  │  │  │   - GRANT SELECT, INSERT, UPDATE, DELETE ON public.*          │ │  │
│  │  │  │   - Subject to RLS policies                                   │ │  │
│  │  │  │                                                               │ │  │
│  │  │  ├─ service_role                                                  │ │  │
│  │  │  │   - GRANT ALL ON public.*                                     │ │  │
│  │  │  │   - BYPASSRLS (绕过 RLS 策略)                                 │ │  │
│  │  │  │                                                               │ │  │
│  │  │  └─ authenticated (未来)                                          │ │  │
│  │  │      - 登录用户角色                                              │ │  │
│  │  │                                                                   │ │  │
│  │  │  RLS Policies:                                                    │ │  │
│  │  │  ├─ users_select_policy                                           │ │  │
│  │  │  │   FOR SELECT TO anon                                          │ │  │
│  │  │  │   USING (is_public = true)                                    │ │  │
│  │  │  │                                                               │ │  │
│  │  │  └─ users_insert_policy                                           │ │  │
│  │  │      FOR INSERT TO anon                                          │ │  │
│  │  │      WITH CHECK (user_id = auth.uid())                           │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │  Database: supabase_project_beta                                  │ │  │
│  │  │  (类似结构，完全隔离)                                              │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │  Database: supabase_project_N                                     │ │  │
│  │  │  (每个租户一个独立数据库)                                          │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                      Data Access Patterns                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  1. Project Creation Flow:                                                   │
│     Studio → Tenant Manager → supabase_platform.projects (INSERT)            │
│                            → supabase_platform.api_keys (INSERT)              │
│                            → supabase_platform.jwt_keys (INSERT)              │
│                            → supabase_platform.postgrest_config (INSERT)      │
│                            → Kong Admin API (consumer + keyauth + ACL)        │
│                            → Lambda (CREATE function)                         │
│                            → Worker RDS (CREATE DATABASE)                     │
│                                                                               │
│  2. API Key Validation Flow:                                                 │
│     Client → Kong → kong.consumers (SELECT by key)                            │
│                  → kong.keyauth_credentials (JOIN)                            │
│                  → kong.acls (JOIN)                                           │
│                                                                               │
│  3. JWT Minting Flow:                                                        │
│     Kong Plugin → Redis (GET jwt:secret:{id})                                │
│                → Tenant Manager API (if cache miss)                          │
│                → supabase_platform.jwt_keys (SELECT)                          │
│                → Redis (SET jwt:secret:{id}, TTL 300)                         │
│                                                                               │
│  4. PostgREST Config Flow:                                                   │
│     Lambda Bootstrap → Tenant Manager API                                    │
│                     → supabase_platform.postgrest_config (SELECT)             │
│                     → Return {db_uri, db_schemas, db_anon_role}               │
│                                                                               │
│  5. Tenant Data Access Flow:                                                 │
│     Client → Kong → Lambda → Worker RDS.supabase_project_X                    │
│                                      → SET LOCAL role TO 'anon'               │
│                                      → SELECT * FROM users (RLS applied)      │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 数据架构关键点

1. **数据分离**：
   - **Platform DB**: 项目元数据、配置、API keys
   - **Kong DB**: Gateway 配置、consumers、路由
   - **Tenant DB**: 每个项目独立数据库，完全隔离

2. **API Key 双存储**：
   - **Kong DB**: 完整 opaque key (`sb_publishable_xxx`) 用于认证
   - **Platform DB**: opaque key + hashed secret 用于管理

3. **缓存策略**：
   - Redis 缓存热数据（JWT secret, Lambda URL）
   - 5分钟 TTL，平衡新鲜度和性能
   - 缓存失效时回源到 tenant-manager API

4. **安全存储**：
   - RDS 连接强制 SSL
   - Secrets Manager 存储 RDS master password
   - API keys 使用 SHA256 hash 存储

5. **扩展性**：
   - Worker RDS 可水平扩展（添加更多实例）
   - 每个实例可托管多个租户数据库
   - 负载均衡器选择最优实例


---

## 5. 服务组件架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Service Component Architecture                         │
│                       Microservices on ECS Fargate + Lambda                  │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                          API Gateway Layer                                    │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Kong Gateway (ECS Fargate)                                            │  │
│  │  Image: <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/kong-configured  │  │
│  │  Resources: 512 CPU / 1024 MB Memory                                   │  │
│  │  Desired Count: 1                                                      │  │
│  │                                                                        │  │
│  │  Responsibilities:                                                     │  │
│  │  ├─ API Gateway (统一入口)                                             │  │
│  │  ├─ 子域名路由 (project-id 提取)                                       │  │
│  │  ├─ API Key 认证 (key-auth plugin)                                    │  │
│  │  ├─ JWT 铸造 (dynamic-lambda-router plugin)                            │  │
│  │  ├─ Lambda 路由 (SigV4 签名)                                           │  │
│  │  ├─ 访问控制 (ACL plugin)                                              │  │
│  │  ├─ CORS 处理                                                          │  │
│  │  └─ 请求/响应转换                                                       │  │
│  │                                                                        │  │
│  │  Configuration:                                                        │  │
│  │  ├─ Database: postgres (DB-backed mode)                                │  │
│  │  ├─ Admin API: :8001 (internal)                                        │  │
│  │  ├─ Proxy: :8000 (public via ALB)                                      │  │
│  │  ├─ Redis: kong-cache.xxx:6379                                         │  │
│  │  └─ Plugins: pre-function, key-auth, dynamic-lambda-router, ACL, CORS │  │
│  │                                                                        │  │
│  │  Custom Plugins:                                                       │  │
│  │  └─ dynamic-lambda-router/                                             │  │
│  │     ├─ handler.lua (核心逻辑)                                          │  │
│  │     │   - mint_jwt()                                                  │  │
│  │     │   - get_project_config()                                        │  │
│  │     │   - sign_sigv4()                                                │  │
│  │     │   - invoke_lambda()                                             │  │
│  │     └─ schema.lua (配置 schema)                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        Management Layer                                       │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Tenant Manager (ECS Fargate)                                          │  │
│  │  Image: <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/tenant-manager   │  │
│  │  Resources: 512 CPU / 1024 MB Memory                                   │  │
│  │  Desired Count: 1                                                      │  │
│  │  Port: 8080 (Fastify)                                                  │  │
│  │                                                                        │  │
│  │  Responsibilities:                                                     │  │
│  │  ├─ 项目生命周期管理 (创建、配置、删除)                                 │  │
│  │  ├─ API Key 管理 (生成、列表、撤销)                                    │  │
│  │  ├─ Lambda 函数管理 (创建、更新、删除)                                  │  │
│  │  ├─ Kong Consumer 注册                                                 │  │
│  │  ├─ RDS 实例管理                                                       │  │
│  │  ├─ 数据库初始化 (schema + roles)                                      │  │
│  │  └─ 配置 API (供 Kong 和 Lambda 查询)                                  │  │
│  │                                                                        │  │
│  │  Modules:                                                              │  │
│  │  ├─ project/                                                           │  │
│  │  │   - project.service.ts (项目 CRUD)                                 │  │
│  │  │   - project.controller.ts (REST API)                               │  │
│  │  │                                                                    │  │
│  │  ├─ api-keys/                                                          │  │
│  │  │   - api-key-generator.ts (opaque key 生成)                         │  │
│  │  │   - api-key.service.ts (key CRUD)                                  │  │
│  │  │                                                                    │  │
│  │  ├─ provisioning/                                                      │  │
│  │  │   - provisioner.service.ts (Lambda + DB 创建)                      │  │
│  │  │   - kong-consumer.service.ts (Kong Admin API)                      │  │
│  │  │                                                                    │  │
│  │  ├─ rds-instance/                                                      │  │
│  │  │   - rds-balancer.service.ts (实例选择)                             │  │
│  │  │   - rds-instance.repository.ts (实例元数据)                        │  │
│  │  │                                                                    │  │
│  │  └─ runtime-config/                                                    │  │
│  │      - config.controller.ts (配置 API)                                │  │
│  │                                                                        │  │
│  │  API Endpoints:                                                        │  │
│  │  ├─ POST   /project/create-pgrest-lambda                               │  │
│  │  ├─ GET    /project/:id/config                                         │  │
│  │  ├─ GET    /project/:id/postgrest-config                               │  │
│  │  ├─ GET    /project/:id/api-keys                                       │  │
│  │  ├─ POST   /project/:id/api-keys                                       │  │
│  │  └─ DELETE /project/:id/api-keys/:keyId                                │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Studio (ECS Fargate)                                                  │  │
│  │  Image: <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/studio           │  │
│  │  Resources: 512 CPU / 1024 MB Memory                                   │  │
│  │  Desired Count: 1                                                      │  │
│  │  Port: 8000 (Next.js)                                                  │  │
│  │                                                                        │  │
│  │  Responsibilities:                                                     │  │
│  │  ├─ Web UI (项目管理界面)                                              │  │
│  │  ├─ SQL Editor (数据库查询)                                            │  │
│  │  ├─ Table Editor (可视化表管理)                                        │  │
│  │  ├─ API Keys 管理                                                      │  │
│  │  ├─ Database Metadata (表、视图、扩展)                                 │  │
│  │  └─ Secrets 管理 (未来)                                                │  │
│  │                                                                        │  │
│  │  API Endpoints (Management API):                                       │  │
│  │  ├─ POST   /api/v1/projects                                            │  │
│  │  ├─ GET    /api/v1/projects                                            │  │
│  │  ├─ GET    /api/v1/projects/:ref                                       │  │
│  │  ├─ GET    /api/v1/projects/:ref/api-keys                              │  │
│  │  ├─ POST   /api/v1/projects/:ref/database/query                        │  │
│  │  ├─ GET    /api/v1/projects/:ref/database/tables                       │  │
│  │  ├─ GET    /api/v1/projects/:ref/database/views                        │  │
│  │  ├─ GET    /api/v1/projects/:ref/database/extensions                   │  │
│  │  └─ POST   /api/v1/projects/:ref/secrets (TODO)                        │  │
│  │                                                                        │  │
│  │  Integration:                                                          │  │
│  │  ├─ Backend: Tenant Manager (项目管理)                                 │  │
│  │  ├─ Backend: postgres-meta (数据库元数据)                              │  │
│  │  └─ Frontend: React + Next.js                                          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                         Compute Layer                                         │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  PostgREST Lambda (Per-Tenant)                                         │  │
│  │  Image: <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/postgrest-lambda │  │
│  │  Memory: 512 MB (可配置 2048 MB)                                        │  │
│  │  Timeout: 30s                                                          │  │
│  │  VPC: Enabled (访问 RDS)                                                │  │
│  │                                                                        │  │
│  │  Components:                                                           │  │
│  │  ├─ Lambda Web Adapter (LWA)                                           │  │
│  │  │   - HTTP → Lambda 事件转换                                          │  │
│  │  │   - X-Client-Authorization → Authorization                         │  │
│  │  │                                                                    │  │
│  │  ├─ PostgREST Binary                                                   │  │
│  │  │   - RESTful API for PostgreSQL                                     │  │
│  │  │   - JWT 验证                                                        │  │
│  │  │   - RLS 执行                                                        │  │
│  │  │                                                                    │  │
│  │  └─ bootstrap.sh                                                       │  │
│  │      - 启动时获取配置                                                   │  │
│  │      - 从 tenant-manager API 或 Secrets Manager                        │  │
│  │                                                                        │  │
│  │  Environment Variables:                                                │  │
│  │  ├─ PROJECT_ID (项目标识)                                              │  │
│  │  ├─ CONFIG_SOURCE (service / secretsmanager)                           │  │
│  │  ├─ CONFIG_SERVICE_URL (tenant-manager endpoint)                       │  │
│  │  └─ AWS_LWA_PORT (8080)                                                │  │
│  │                                                                        │  │
│  │  Configuration (from tenant-manager):                                  │  │
│  │  ├─ PGRST_DB_URI (数据库连接字符串)                                    │  │
│  │  ├─ PGRST_DB_SCHEMAS (public)                                          │  │
│  │  ├─ PGRST_DB_ANON_ROLE (anon)                                          │  │
│  │  ├─ PGRST_JWT_SECRET (JWT 验证密钥)                                    │  │
│  │  └─ PGRST_DB_USE_LEGACY_GUCS (false)                                   │  │
│  │                                                                        │  │
│  │  Invocation:                                                           │  │
│  │  ├─ Function URL (public, IAM auth)                                    │  │
│  │  ├─ SigV4 签名 (by Kong)                                               │  │
│  │  └─ Cold start: ~1-2s, Warm: <100ms                                    │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Functions Service (ECS Fargate)                                       │  │
│  │  Image: <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/functions-service│  │
│  │  Resources: 256 CPU / 512 MB Memory                                    │  │
│  │  Desired Count: 1                                                      │  │
│  │  Port: 8080                                                            │  │
│  │                                                                        │  │
│  │  Responsibilities:                                                     │  │
│  │  ├─ Edge Functions 执行 (Deno runtime)                                 │  │
│  │  ├─ 函数部署和版本管理                                                  │  │
│  │  ├─ 环境变量注入                                                        │  │
│  │  └─ 日志收集                                                           │  │
│  │                                                                        │  │
│  │  API Endpoints:                                                        │  │
│  │  ├─ POST   /functions/v1/:function_name                                │  │
│  │  ├─ GET    /functions/v1/:function_name                                │  │
│  │  └─ DELETE /functions/v1/:function_name                                │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        Supporting Services                                    │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  postgres-meta (ECS Fargate)                                           │  │
│  │  Image: <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/postgres-meta    │  │
│  │  Resources: 256 CPU / 512 MB Memory                                    │  │
│  │  Port: 8080                                                            │  │
│  │                                                                        │  │
│  │  Responsibilities:                                                     │  │
│  │  ├─ PostgreSQL 元数据 API                                              │  │
│  │  ├─ 表、视图、列、索引查询                                              │  │
│  │  ├─ 扩展、函数、触发器管理                                              │  │
│  │  └─ Schema 可视化                                                      │  │
│  │                                                                        │  │
│  │  Used by: Studio (database metadata endpoints)                         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  db-admin Lambda                                                       │  │
│  │  Image: <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/db-admin-lambda  │  │
│  │  Memory: 256 MB                                                        │  │
│  │                                                                        │  │
│  │  Responsibilities:                                                     │  │
│  │  ├─ 数据库管理操作 (list_databases, execute_sql)                       │  │
│  │  ├─ 测试和调试工具                                                      │  │
│  │  └─ 直接 SQL 执行                                                      │  │
│  │                                                                        │  │
│  │  Operations:                                                           │  │
│  │  ├─ list_databases                                                     │  │
│  │  └─ execute_sql (database, sql)                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                      Service Communication                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Service Discovery (AWS Cloud Map):                                          │
│  ├─ Namespace: kong.local (private DNS)                                      │
│  ├─ kong-gateway.kong.local:8000 (proxy)                                     │
│  ├─ kong-gateway.kong.local:8001 (admin)                                     │
│  ├─ tenant-manager.kong.local:8080                                            │
│  ├─ functions-service.kong.local:8080                                         │
│  └─ postgres-meta.kong.local:8080                                             │
│                                                                               │
│  Communication Patterns:                                                      │
│  ├─ Client → ALB → Kong (HTTPS)                                              │
│  ├─ Kong → Lambda (Function URL + SigV4)                                      │
│  ├─ Kong → Tenant Manager (HTTP, internal)                                   │
│  ├─ Kong → Functions Service (HTTP, internal)                                │
│  ├─ Tenant Manager → Kong Admin API (HTTP, :8001)                            │
│  ├─ Tenant Manager → RDS (PostgreSQL, SSL)                                   │
│  ├─ Lambda → Tenant Manager (HTTP, internal)                                 │
│  ├─ Lambda → RDS (PostgreSQL, SSL)                                           │
│  ├─ Studio → Tenant Manager (HTTP, internal)                                 │
│  └─ Studio → postgres-meta (HTTP, internal)                                  │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 服务组件关键点

1. **Kong Gateway**：
   - 统一 API 入口，处理所有外部请求
   - DB-backed 模式，动态 consumer 注册
   - 自定义插件实现 JWT 铸造和 Lambda 路由

2. **Tenant Manager**：
   - 核心管理服务，整合了原 project-service 功能
   - 负责完整的项目生命周期
   - 提供配置 API 供 Kong 和 Lambda 查询

3. **PostgREST Lambda**：
   - 每个租户独立 Lambda 函数
   - 冷启动优化：512MB 内存，VPC 预热
   - Lambda Web Adapter 实现 HTTP → Lambda 转换

4. **Studio**：
   - 管理界面，基于 Supabase 官方 Studio
   - 集成 tenant-manager 和 postgres-meta
   - 提供统一的项目管理体验

5. **服务发现**：
   - AWS Cloud Map 提供内部 DNS
   - 服务间通过 DNS 名称通信
   - 无需硬编码 IP 地址


---

## 6. 安全架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Security Architecture                               │
│                     Defense in Depth - 多层安全防护                          │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        Layer 1: Network Security                              │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  VPC Isolation                                                         │  │
│  │  ├─ Private Subnets (应用层)                                           │  │
│  │  │   - 无直接 Internet 访问                                            │  │
│  │  │   - 通过 NAT Gateway 出站                                           │  │
│  │  │                                                                    │  │
│  │  ├─ Security Groups (Stateful Firewall)                                │  │
│  │  │   - 最小权限原则                                                    │  │
│  │  │   - 仅允许必要端口和来源                                            │  │
│  │  │   - 拒绝所有未明确允许的流量                                        │  │
│  │  │                                                                    │  │
│  │  └─ Network ACLs (Stateless Firewall)                                  │  │
│  │      - 子网级别访问控制                                                │  │
│  │      - 额外的防护层                                                    │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Security Group Rules (详细)                                           │  │
│  │                                                                        │  │
│  │  ALBSG → KongSG                                                        │  │
│  │    ✓ TCP 8000 (Kong Proxy)                                             │  │
│  │    ✗ All other ports                                                   │  │
│  │                                                                        │  │
│  │  KongSG → RdsSG                                                        │  │
│  │    ✓ TCP 5432 (PostgreSQL)                                             │  │
│  │    ✗ All other ports                                                   │  │
│  │                                                                        │  │
│  │  KongSG → RedisSG                                                      │  │
│  │    ✓ TCP 6379 (Redis)                                                  │  │
│  │    ✗ All other ports                                                   │  │
│  │                                                                        │  │
│  │  LambdaSG → RdsSG                                                      │  │
│  │    ✓ TCP 5432 (PostgreSQL)                                             │  │
│  │    ✗ All other ports                                                   │  │
│  │                                                                        │  │
│  │  TenantManagerSG → RdsSG                                                │  │
│  │    ✓ TCP 5432 (PostgreSQL)                                             │  │
│  │    ✗ All other ports                                                   │  │
│  │                                                                        │  │
│  │  RdsSG                                                                  │  │
│  │    ✓ Inbound from LambdaSG, KongSG, TenantManagerSG only               │  │
│  │    ✗ No outbound (data layer isolation)                                │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                      Layer 2: Transport Security                              │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  TLS/SSL Encryption                                                    │  │
│  │                                                                        │  │
│  │  Client → ALB                                                          │  │
│  │    ✓ HTTPS (TLS 1.2+)                                                  │  │
│  │    ✓ ACM Certificate (*.example.com)                                │  │
│  │    ✓ Strong cipher suites                                              │  │
│  │                                                                        │  │
│  │  ALB → Kong                                                            │  │
│  │    ○ HTTP (internal VPC, encrypted at network layer)                   │  │
│  │                                                                        │  │
│  │  Kong → Lambda                                                         │  │
│  │    ✓ HTTPS (Function URL with TLS)                                     │  │
│  │    ✓ SigV4 signature                                                   │  │
│  │                                                                        │  │
│  │  Lambda/Kong/TenantManager → RDS                                       │  │
│  │    ✓ PostgreSQL SSL (required)                                         │  │
│  │    ✓ ssl=on, sslmode=require                                           │  │
│  │    ○ sslverify=off (RDS managed cert)                                  │  │
│  │                                                                        │  │
│  │  Kong → Redis                                                          │  │
│  │    ○ Unencrypted (internal VPC, ElastiCache in-transit encryption可选) │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                    Layer 3: Authentication & Authorization                    │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  API Key Authentication (Kong key-auth)                                │  │
│  │                                                                        │  │
│  │  1. Client 发送请求                                                    │  │
│  │     Authorization: Bearer sb_publishable_abc123xyz...                  │  │
│  │                                                                        │  │
│  │  2. Kong 提取 API key                                                  │  │
│  │     key = extract_from_header("Authorization")                         │  │
│  │                                                                        │  │
│  │  3. Kong DB 查询                                                       │  │
│  │     SELECT c.* FROM consumers c                                        │  │
│  │     JOIN keyauth_credentials k ON k.consumer_id = c.id                 │  │
│  │     WHERE k.key = 'sb_publishable_abc123xyz...'                        │  │
│  │                                                                        │  │
│  │  4. 验证成功                                                           │  │
│  │     - 设置 authenticated_consumer                                      │  │
│  │     - 移除 Authorization header (hide_credentials: true)               │  │
│  │     - 继续执行后续插件                                                  │  │
│  │                                                                        │  │
│  │  5. 验证失败                                                           │  │
│  │     - 返回 401 Unauthorized                                            │  │
│  │     - 记录失败日志                                                      │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  JWT Authentication (PostgREST)                                        │  │
│  │                                                                        │  │
│  │  1. Kong 铸造短期 JWT                                                  │  │
│  │     payload = {                                                        │  │
│  │       iss: "supabase",                                                 │  │
│  │       ref: "project-alpha",                                            │  │
│  │       role: "anon",                                                    │  │
│  │       iat: 1709123456,                                                 │  │
│  │       exp: 1709123756  // 5 minutes                                    │  │
│  │     }                                                                  │  │
│  │     jwt = HS256_sign(payload, jwt_secret)                              │  │
│  │                                                                        │  │
│  │  2. Lambda 接收 JWT                                                    │  │
│  │     Authorization: Bearer <jwt-token>...                                │  │
│  │                                                                        │  │
│  │  3. PostgREST 验证 JWT                                                 │  │
│  │     - 验证签名 (使用 jwt_secret)                                        │  │
│  │     - 检查 exp (过期时间)                                               │  │
│  │     - 检查 iss (签发者)                                                 │  │
│  │     - 提取 role                                                        │  │
│  │                                                                        │  │
│  │  4. 设置 PostgreSQL 会话                                               │  │
│  │     SET LOCAL role TO 'anon';                                          │  │
│  │     SET LOCAL request.jwt.claims TO '{"role":"anon",...}';            │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Access Control (Kong ACL + PostgreSQL RLS)                            │  │
│  │                                                                        │  │
│  │  Kong ACL:                                                             │  │
│  │  ├─ Consumer: project-alpha--anon                                      │  │
│  │  │   ACL Group: anon                                                   │  │
│  │  │   Allowed Routes: /rest/v1/* (read-only operations)                │  │
│  │  │                                                                    │  │
│  │  └─ Consumer: project-alpha--service_role                              │  │
│  │      ACL Group: admin                                                  │  │
│  │      Allowed Routes: /rest/v1/* (all operations)                       │  │
│  │                                                                        │  │
│  │  PostgreSQL RLS:                                                       │  │
│  │  ├─ Role: anon                                                         │  │
│  │  │   - Subject to RLS policies                                        │  │
│  │  │   - GRANT SELECT, INSERT, UPDATE, DELETE ON public.*               │  │
│  │  │   - Policies enforce row-level access                              │  │
│  │  │                                                                    │  │
│  │  └─ Role: service_role                                                 │  │
│  │      - BYPASSRLS (绕过 RLS)                                            │  │
│  │      - GRANT ALL ON public.*                                           │  │
│  │      - 完全数据库访问权限                                              │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                      Layer 4: Data Security                                   │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Encryption at Rest                                                    │  │
│  │                                                                        │  │
│  │  RDS PostgreSQL:                                                       │  │
│  │  ✓ Storage encryption enabled (AWS KMS)                                │  │
│  │  ✓ Automated backups encrypted                                         │  │
│  │  ✓ Snapshots encrypted                                                 │  │
│  │                                                                        │  │
│  │  Secrets Manager:                                                      │  │
│  │  ✓ Secrets encrypted with KMS                                          │  │
│  │  ✓ Automatic rotation support                                          │  │
│  │                                                                        │  │
│  │  ElastiCache Redis:                                                    │  │
│  │  ○ At-rest encryption (可选，未启用)                                    │  │
│  │  ○ In-transit encryption (可选，未启用)                                 │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Sensitive Data Handling                                               │  │
│  │                                                                        │  │
│  │  API Keys:                                                             │  │
│  │  ├─ Storage: supabase_platform.api_keys                                │  │
│  │  │   - key_value: 完整 opaque key (用于 Kong 认证)                    │  │
│  │  │   - hashed_secret: SHA256(secret) (用于验证)                        │  │
│  │  │                                                                    │  │
│  │  ├─ Transmission: HTTPS only                                           │  │
│  │  └─ Display: 仅在创建时显示完整 key，后续仅显示前缀                    │  │
│  │                                                                        │  │
│  │  JWT Secrets:                                                          │  │
│  │  ├─ Storage: supabase_platform.jwt_keys                                │  │
│  │  │   - secret: 256-bit random string                                  │  │
│  │  │   - algorithm: HS256                                                │  │
│  │  │                                                                    │  │
│  │  ├─ Caching: Redis (TTL 300s)                                          │  │
│  │  └─ Transmission: Internal VPC only                                    │  │
│  │                                                                        │  │
│  │  Database Credentials:                                                 │  │
│  │  ├─ Master password: Secrets Manager (auto-generated)                  │  │
│  │  ├─ Tenant passwords: Generated per-project                            │  │
│  │  └─ Connection strings: Environment variables (encrypted)              │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Multi-Tenant Isolation                                                │  │
│  │                                                                        │  │
│  │  Database Level:                                                       │  │
│  │  ├─ 每个租户独立数据库                                                  │  │
│  │  ├─ 独立的 database owner role                                         │  │
│  │  ├─ 无跨数据库查询能力                                                  │  │
│  │  └─ 物理隔离（不同 RDS 实例可选）                                       │  │
│  │                                                                        │  │
│  │  Lambda Level:                                                         │  │
│  │  ├─ 每个租户独立 Lambda 函数                                            │  │
│  │  ├─ 独立的执行环境                                                      │  │
│  │  ├─ 独立的 IAM 角色                                                     │  │
│  │  └─ 独立的日志流                                                        │  │
│  │                                                                        │  │
│  │  Network Level:                                                        │  │
│  │  ├─ Kong 路由隔离 (基于 project_id)                                    │  │
│  │  ├─ Security Group 隔离                                                │  │
│  │  └─ VPC 内部通信                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                      Layer 5: Operational Security                            │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  IAM Roles & Policies                                                  │  │
│  │                                                                        │  │
│  │  ECS Task Role (Kong, Tenant Manager, Studio):                         │  │
│  │  ├─ ecr:GetAuthorizationToken                                          │  │
│  │  ├─ ecr:BatchGetImage                                                  │  │
│  │  ├─ logs:CreateLogStream, logs:PutLogEvents                            │  │
│  │  ├─ secretsmanager:GetSecretValue (RDS credentials)                    │  │
│  │  └─ servicediscovery:DiscoverInstances                                 │  │
│  │                                                                        │  │
│  │  Lambda Execution Role (PostgREST):                                    │  │
│  │  ├─ logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents      │  │
│  │  ├─ ec2:CreateNetworkInterface, ec2:DescribeNetworkInterfaces (VPC)   │  │
│  │  ├─ secretsmanager:GetSecretValue (config, optional)                   │  │
│  │  └─ rds:DescribeDBInstances (optional)                                 │  │
│  │                                                                        │  │
│  │  Tenant Manager Role (额外权限):                                        │  │
│  │  ├─ lambda:CreateFunction, lambda:UpdateFunctionCode                   │  │
│  │  ├─ lambda:CreateFunctionUrlConfig                                     │  │
│  │  ├─ iam:PassRole (Lambda execution role)                               │  │
│  │  ├─ secretsmanager:CreateSecret, secretsmanager:PutSecretValue         │  │
│  │  └─ rds:CreateDBInstance (optional, for dedicated instances)           │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Logging & Monitoring                                                  │  │
│  │                                                                        │  │
│  │  CloudWatch Logs:                                                      │  │
│  │  ├─ /ecs/supabase (Kong, Tenant Manager, Studio, Functions)            │  │
│  │  ├─ /aws/lambda/postgrest-{project_id} (per-tenant)                    │  │
│  │  └─ /aws/rds/instance/{instance_id}/postgresql (RDS logs)              │  │
│  │                                                                        │  │
│  │  Audit Logging:                                                        │  │
│  │  ├─ Kong access logs (all API requests)                                │  │
│  │  ├─ Tenant Manager operation logs (project CRUD)                       │  │
│  │  ├─ Lambda invocation logs (PostgREST queries)                         │  │
│  │  └─ RDS query logs (slow queries, errors)                              │  │
│  │                                                                        │  │
│  │  Security Monitoring:                                                  │  │
│  │  ├─ Failed authentication attempts (Kong 401 responses)                │  │
│  │  ├─ Unusual API usage patterns                                         │  │
│  │  ├─ Lambda cold start metrics                                          │  │
│  │  └─ RDS connection pool exhaustion                                     │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Secrets Rotation                                                      │  │
│  │                                                                        │  │
│  │  RDS Master Password:                                                  │  │
│  │  ├─ Stored in Secrets Manager                                          │  │
│  │  ├─ Automatic rotation (可配置)                                        │  │
│  │  └─ Zero-downtime rotation                                             │  │
│  │                                                                        │  │
│  │  API Keys:                                                             │  │
│  │  ├─ Manual rotation (通过 Studio/API)                                  │  │
│  │  ├─ 创建新 key → 更新应用 → 删除旧 key                                  │  │
│  │  └─ 支持多个 active keys (过渡期)                                      │  │
│  │                                                                        │  │
│  │  JWT Secrets:                                                          │  │
│  │  ├─ Manual rotation (需要协调)                                         │  │
│  │  ├─ 更新 supabase_platform.jwt_keys                                    │  │
│  │  ├─ 清除 Redis 缓存                                                    │  │
│  │  └─ 重启 Lambda (自动获取新 secret)                                    │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                      Security Best Practices                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ✓ Principle of Least Privilege (最小权限原则)                                │
│    - IAM roles 仅授予必要权限                                                 │
│    - Security groups 仅开放必要端口                                           │
│    - Database roles 仅授予必要表权限                                          │
│                                                                               │
│  ✓ Defense in Depth (纵深防御)                                                │
│    - 5 层安全防护：网络、传输、认证、数据、运营                                │
│    - 单点失败不会导致整体安全失效                                              │
│                                                                               │
│  ✓ Encryption Everywhere (全程加密)                                           │
│    - 传输加密：HTTPS, PostgreSQL SSL                                          │
│    - 静态加密：RDS storage, Secrets Manager                                   │
│                                                                               │
│  ✓ Multi-Tenant Isolation (多租户隔离)                                        │
│    - 数据库级别隔离                                                           │
│    - Lambda 函数隔离                                                          │
│    - 网络路由隔离                                                             │
│                                                                               │
│  ✓ Short-Lived Credentials (短期凭证)                                         │
│    - JWT 5分钟有效期                                                          │
│    - 限制重放攻击窗口                                                         │
│                                                                               │
│  ✓ Audit & Monitoring (审计与监控)                                            │
│    - 所有 API 请求记录                                                        │
│    - 失败认证告警                                                             │
│    - 异常行为检测                                                             │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 安全架构关键点

1. **多层防护**：5 层安全防护确保单点失败不会导致整体失效
2. **最小权限**：所有组件仅授予必要的最小权限
3. **加密传输**：所有敏感数据传输使用 TLS/SSL 加密
4. **租户隔离**：数据库、Lambda、网络三层隔离
5. **短期凭证**：JWT 5分钟有效期限制重放攻击
6. **审计日志**：完整的操作日志用于安全审计


---

## 7. 部署架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Deployment Architecture                              │
│                    CI/CD Pipeline & Infrastructure as Code                   │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        Infrastructure as Code (AWS CDK)                       │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  CDK Stack Structure                                                   │  │
│  │                                                                        │  │
│  │  infra/                                                                │  │
│  │  ├─ bin/                                                               │  │
│  │  │   └─ kong-ecs-fargate.ts (CDK app entry point)                     │  │
│  │  │                                                                    │  │
│  │  ├─ lib/                                                               │  │
│  │  │   └─ supabase-stack.ts (Main stack definition)                     │  │
│  │  │       ├─ VPC (2 AZs, 1 NAT Gateway)                                │  │
│  │  │       ├─ Security Groups (7 groups)                                │  │
│  │  │       ├─ RDS PostgreSQL (Primary + Worker)                         │  │
│  │  │       ├─ ElastiCache Redis                                         │  │
│  │  │       ├─ ECS Cluster                                               │  │
│  │  │       ├─ ECS Services (Kong, Tenant Manager, Studio, Functions)    │  │
│  │  │       ├─ Application Load Balancers (3)                            │  │
│  │  │       ├─ AWS Cloud Map (Service Discovery)                         │  │
│  │  │       └─ IAM Roles & Policies                                      │  │
│  │  │                                                                    │  │
│  │  ├─ cdk.json (CDK configuration)                                       │  │
│  │  ├─ package.json (Dependencies)                                        │  │
│  │  └─ tsconfig.json (TypeScript config)                                  │  │
│  │                                                                        │  │
│  │  Configuration Source:                                                 │  │
│  │  └─ config.json (Project root)                                         │  │
│  │      - Single source of truth                                          │  │
│  │      - ECR URIs, resource allocations, domain config                   │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  CDK Deployment Commands                                               │  │
│  │                                                                        │  │
│  │  # Bootstrap CDK (first time only)                                     │  │
│  │  cdk bootstrap aws://<AWS_ACCOUNT_ID>/us-east-1                            │  │
│  │                                                                        │  │
│  │  # Synthesize CloudFormation template                                  │  │
│  │  cd infra && npm run build && cdk synth                                │  │
│  │                                                                        │  │
│  │  # Deploy stack                                                        │  │
│  │  cdk deploy SupabaseStack                                              │  │
│  │                                                                        │  │
│  │  # Diff changes                                                        │  │
│  │  cdk diff SupabaseStack                                                │  │
│  │                                                                        │  │
│  │  # Destroy stack (careful!)                                            │  │
│  │  cdk destroy SupabaseStack                                             │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        Container Build & Push Pipeline                        │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Build Script (build-and-push.sh)                                      │  │
│  │                                                                        │  │
│  │  Usage:                                                                │  │
│  │  ./build-and-push.sh [service]                                         │  │
│  │                                                                        │  │
│  │  Services:                                                             │  │
│  │  ├─ kong           (Kong Gateway with custom plugins)                  │  │
│  │  ├─ tenant-manager (Tenant management service)                         │  │
│  │  ├─ project        (Legacy project service)                            │  │
│  │  ├─ postgrest-lambda (PostgREST Lambda container)                      │  │
│  │  ├─ functions      (Edge Functions service)                            │  │
│  │  ├─ studio         (Supabase Studio)                                   │  │
│  │  └─ all            (Build all services)                                │  │
│  │                                                                        │  │
│  │  Build Process:                                                        │  │
│  │  1. Read config.json for ECR URIs                                      │  │
│  │  2. AWS ECR login                                                      │  │
│  │  3. Docker build (multi-stage for optimization)                        │  │
│  │  4. Docker tag (latest + git commit hash)                              │  │
│  │  5. Docker push to ECR                                                 │  │
│  │  6. Output image URI                                                   │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  ECR Repositories                                                      │  │
│  │                                                                        │  │
│  │  <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/                         │  │
│  │  ├─ kong-configured                                                    │  │
│  │  │   Base: kong:3.5                                                    │  │
│  │  │   + Custom plugins (dynamic-lambda-router)                          │  │
│  │  │   + kong.yml.tpl                                                    │  │
│  │  │   + docker-entrypoint-custom.sh                                     │  │
│  │  │                                                                    │  │
│  │  ├─ tenant-manager                                                     │  │
│  │  │   Base: node:20-alpine                                              │  │
│  │  │   + TypeScript compiled code                                        │  │
│  │  │   + Dependencies (Fastify, Kysely, pg)                              │  │
│  │  │                                                                    │  │
│  │  ├─ postgrest-lambda                                                   │  │
│  │  │   Base: public.ecr.aws/lambda/provided:al2                          │  │
│  │  │   + PostgREST binary                                                │  │
│  │  │   + Lambda Web Adapter                                              │  │
│  │  │   + bootstrap.sh                                                    │  │
│  │  │                                                                    │  │
│  │  ├─ studio                                                             │  │
│  │  │   Base: node:20-alpine                                              │  │
│  │  │   + Next.js build                                                   │  │
│  │  │   + Supabase Studio frontend                                        │  │
│  │  │                                                                    │  │
│  │  ├─ functions-service                                                  │  │
│  │  │   Base: denoland/deno:alpine                                        │  │
│  │  │   + Edge Functions runtime                                          │  │
│  │  │                                                                    │  │
│  │  └─ db-admin-lambda                                                    │  │
│  │      Base: public.ecr.aws/lambda/python:3.12                           │  │
│  │      + psycopg2 + boto3                                                │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        ECS Service Deployment                                 │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Deployment Process                                                    │  │
│  │                                                                        │  │
│  │  1. Build & Push Image                                                 │  │
│  │     ./build-and-push.sh kong                                           │  │
│  │     → Image: kong-configured:abc123                                    │  │
│  │                                                                        │  │
│  │  2. Update ECS Task Definition (automatic)                             │  │
│  │     - ECS pulls latest image from ECR                                  │  │
│  │     - Creates new task definition revision                             │  │
│  │                                                                        │  │
│  │  3. Force New Deployment                                               │  │
│  │     aws ecs update-service \                                           │  │
│  │       --cluster <ECS_CLUSTER> \                                   │  │
│  │       --service kong-gateway \                                         │  │
│  │       --force-new-deployment \                                         │  │
│  │       --region us-east-1                                               │  │
│  │                                                                        │  │
│  │  4. Rolling Update                                                     │  │
│  │     - ECS starts new task with new image                               │  │
│  │     - Health check passes                                              │  │
│  │     - ALB routes traffic to new task                                   │  │
│  │     - Old task drains connections                                      │  │
│  │     - Old task terminates                                              │  │
│  │                                                                        │  │
│  │  5. Verify Deployment                                                  │  │
│  │     aws ecs describe-services \                                        │  │
│  │       --cluster <ECS_CLUSTER> \                                   │  │
│  │       --services kong-gateway \                                        │  │
│  │       --query 'services[0].[serviceName,status,runningCount]'         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Rollback Strategy                                                     │  │
│  │                                                                        │  │
│  │  Option 1: Revert to Previous Task Definition                          │  │
│  │  aws ecs update-service \                                              │  │
│  │    --cluster <ECS_CLUSTER> \                                      │  │
│  │    --service kong-gateway \                                            │  │
│  │    --task-definition kong-gateway:42  # previous revision              │  │
│  │                                                                        │  │
│  │  Option 2: Rebuild & Deploy Previous Image                             │  │
│  │  git checkout <previous-commit>                                        │  │
│  │  ./build-and-push.sh kong                                              │  │
│  │  aws ecs update-service --force-new-deployment ...                     │  │
│  │                                                                        │  │
│  │  Option 3: CDK Rollback (infrastructure changes)                       │  │
│  │  cdk deploy SupabaseStack --rollback                                   │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        Lambda Deployment                                      │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Per-Tenant Lambda Creation (via Tenant Manager)                       │  │
│  │                                                                        │  │
│  │  POST /project/create-pgrest-lambda                                    │  │
│  │  {                                                                     │  │
│  │    "projectId": "project-alpha"                                        │  │
│  │  }                                                                     │  │
│  │                                                                        │  │
│  │  Process:                                                              │  │
│  │  1. Generate project metadata (API keys, JWT secret)                   │  │
│  │  2. Create tenant database on Worker RDS                               │  │
│  │  3. Initialize database (schema, roles, RLS)                           │  │
│  │  4. Create Lambda function                                             │  │
│  │     - Function name: postgrest-project-alpha                           │  │
│  │     - Image: postgrest-lambda:latest                                   │  │
│  │     - Memory: 512 MB                                                   │  │
│  │     - Timeout: 30s                                                     │  │
│  │     - VPC: Enabled                                                     │  │
│  │     - Environment:                                                     │  │
│  │       PROJECT_ID=project-alpha                                         │  │
│  │       CONFIG_SOURCE=service                                            │  │
│  │       CONFIG_SERVICE_URL=http://tenant-manager:8080                    │  │
│  │  5. Create Function URL (public, IAM auth)                             │  │
│  │  6. Register Kong consumers (anon + service_role)                      │  │
│  │  7. Store metadata in supabase_platform DB                             │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Lambda Image Update (Global)                                          │  │
│  │                                                                        │  │
│  │  1. Build & Push New Image                                             │  │
│  │     ./build-and-push.sh postgrest-lambda                               │  │
│  │     → Image: postgrest-lambda:def456                                   │  │
│  │                                                                        │  │
│  │  2. Update All Tenant Lambdas (Script)                                 │  │
│  │     for project in $(list_all_projects); do                            │  │
│  │       aws lambda update-function-code \                                │  │
│  │         --function-name postgrest-$project \                           │  │
│  │         --image-uri <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/\     │  │
│  │                     postgrest-lambda:def456                            │  │
│  │     done                                                               │  │
│  │                                                                        │  │
│  │  3. Wait for Updates to Complete                                       │  │
│  │     aws lambda wait function-updated \                                 │  │
│  │       --function-name postgrest-$project                               │  │
│  │                                                                        │  │
│  │  4. Verify (Test Request)                                              │  │
│  │     curl https://project-alpha.example.com/rest/v1/health           │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        Monitoring & Observability                             │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  CloudWatch Logs                                                       │  │
│  │                                                                        │  │
│  │  Log Groups:                                                           │  │
│  │  ├─ /ecs/supabase                                                      │  │
│  │  │   - Kong Gateway logs                                               │  │
│  │  │   - Tenant Manager logs                                             │  │
│  │  │   - Studio logs                                                     │  │
│  │  │   - Functions Service logs                                          │  │
│  │  │                                                                    │  │
│  │  ├─ /aws/lambda/postgrest-{project_id}                                 │  │
│  │  │   - Per-tenant Lambda logs                                          │  │
│  │  │   - PostgREST query logs                                            │  │
│  │  │   - Bootstrap logs                                                  │  │
│  │  │                                                                    │  │
│  │  └─ /aws/rds/instance/{instance_id}/postgresql                         │  │
│  │      - PostgreSQL logs                                                 │  │
│  │      - Slow query logs                                                 │  │
│  │      - Error logs                                                      │  │
│  │                                                                        │  │
│  │  Log Queries:                                                          │  │
│  │  # Tail Kong logs (last 10 minutes)                                    │  │
│  │  aws logs tail /ecs/supabase --since 10m --region us-east-1            │  │
│  │                                                                        │  │
│  │  # Filter Tenant Manager logs                                          │  │
│  │  aws logs tail /ecs/supabase --since 5m \                              │  │
│  │    --filter-pattern "tenant-manager" --region us-east-1                │  │
│  │                                                                        │  │
│  │  # Lambda logs for specific project                                    │  │
│  │  aws logs tail /aws/lambda/postgrest-project-alpha \                   │  │
│  │    --since 5m --region us-east-1                                       │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  CloudWatch Metrics                                                    │  │
│  │                                                                        │  │
│  │  ECS Metrics:                                                          │  │
│  │  ├─ CPUUtilization (per service)                                       │  │
│  │  ├─ MemoryUtilization (per service)                                    │  │
│  │  ├─ RunningTaskCount                                                   │  │
│  │  └─ DesiredTaskCount                                                   │  │
│  │                                                                        │  │
│  │  Lambda Metrics:                                                       │  │
│  │  ├─ Invocations (per function)                                         │  │
│  │  ├─ Duration (p50, p99)                                                │  │
│  │  ├─ Errors                                                             │  │
│  │  ├─ Throttles                                                          │  │
│  │  └─ ConcurrentExecutions                                               │  │
│  │                                                                        │  │
│  │  RDS Metrics:                                                          │  │
│  │  ├─ DatabaseConnections                                                │  │
│  │  ├─ CPUUtilization                                                     │  │
│  │  ├─ FreeableMemory                                                     │  │
│  │  ├─ ReadLatency / WriteLatency                                         │  │
│  │  └─ FreeStorageSpace                                                   │  │
│  │                                                                        │  │
│  │  ALB Metrics:                                                          │  │
│  │  ├─ RequestCount                                                       │  │
│  │  ├─ TargetResponseTime                                                 │  │
│  │  ├─ HTTPCode_Target_2XX_Count                                          │  │
│  │  ├─ HTTPCode_Target_4XX_Count                                          │  │
│  │  └─ HTTPCode_Target_5XX_Count                                          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Health Checks                                                         │  │
│  │                                                                        │  │
│  │  ALB Target Health:                                                    │  │
│  │  ├─ Kong: GET /health (port 8000)                                      │  │
│  │  ├─ Tenant Manager: GET /health (port 8080)                            │  │
│  │  ├─ Studio: GET /api/health (port 8000)                                │  │
│  │  └─ Functions: GET /health (port 8080)                                 │  │
│  │                                                                        │  │
│  │  ECS Task Health:                                                      │  │
│  │  - Container health check (Docker HEALTHCHECK)                         │  │
│  │  - Interval: 30s                                                       │  │
│  │  - Timeout: 5s                                                         │  │
│  │  - Retries: 3                                                          │  │
│  │                                                                        │  │
│  │  RDS Health:                                                           │  │
│  │  - AWS managed health checks                                           │  │
│  │  - Automated backups                                                   │  │
│  │  - Multi-AZ failover (if enabled)                                      │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        Deployment Checklist                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Infrastructure Deployment:                                                   │
│  ☐ Update config.json with desired configuration                             │
│  ☐ Review CDK diff: cdk diff SupabaseStack                                   │
│  ☐ Deploy CDK stack: cdk deploy SupabaseStack                                │
│  ☐ Verify VPC, Security Groups, RDS, Redis created                           │
│  ☐ Verify ECS cluster and services running                                   │
│  ☐ Verify ALBs healthy and DNS resolving                                     │
│                                                                               │
│  Application Deployment:                                                      │
│  ☐ Build and push all images: ./build-and-push.sh all                        │
│  ☐ Force ECS service updates (if needed)                                     │
│  ☐ Verify all tasks running and healthy                                      │
│  ☐ Test Kong health: curl https://api.example.com/health                  │
│  ☐ Test Studio: curl https://studio.example.com/api/health                │
│                                                                               │
│  Database Setup:                                                              │
│  ☐ Run platform DB migrations (supabase_platform schema)                     │
│  ☐ Verify Kong DB initialized (migrations bootstrap)                         │
│  ☐ Test database connectivity from ECS tasks                                 │
│                                                                               │
│  Project Creation:                                                            │
│  ☐ Create test project via Studio or API                                     │
│  ☐ Verify Lambda function created                                            │
│  ☐ Verify Kong consumers registered                                          │
│  ☐ Verify tenant database created                                            │
│  ☐ Test API: curl https://test-project.example.com/rest/v1/               │
│                                                                               │
│  Monitoring Setup:                                                            │
│  ☐ Verify CloudWatch log groups created                                      │
│  ☐ Set up CloudWatch alarms (CPU, memory, errors)                            │
│  ☐ Configure log retention policies                                          │
│  ☐ Set up SNS notifications for critical alerts                              │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 部署架构关键点

1. **Infrastructure as Code**：
   - AWS CDK (TypeScript) 管理所有基础设施
   - config.json 作为单一配置源
   - 版本控制和可重复部署

2. **容器化部署**：
   - 所有服务容器化（Docker）
   - ECR 作为私有镜像仓库
   - 统一的构建和推送脚本

3. **滚动更新**：
   - ECS 自动滚动更新
   - 零停机部署
   - 健康检查确保服务可用

4. **Lambda 管理**：
   - 每个租户独立 Lambda 函数
   - 统一的镜像更新流程
   - 自动配置获取

5. **监控和日志**：
   - CloudWatch 集中日志管理
   - 详细的指标监控
   - 健康检查和告警

---

## 总结

本文档从 7 个不同角度详细展示了 Supabase-on-AWS 项目的完整架构：

1. **总体系统架构**：展示了整体的系统布局和组件关系
2. **网络与基础设施架构**：详细的 VPC、子网、安全组配置
3. **请求流程架构**：Gateway JWT Minting 的完整请求链路
4. **数据流架构**：平台数据和租户数据的分离与流转
5. **服务组件架构**：各个微服务的职责和通信方式
6. **安全架构**：5 层安全防护的详细设计
7. **部署架构**：CI/CD 流程和运维实践

### 架构亮点

- **多租户隔离**：数据库、Lambda、网络三层隔离确保租户安全
- **Gateway JWT Minting**：创新的认证模式，平衡安全性和易用性
- **Infrastructure as Code**：AWS CDK 实现可重复、可审计的基础设施
- **微服务架构**：松耦合的服务设计，易于扩展和维护
- **Defense in Depth**：5 层安全防护，确保系统安全性

### 技术栈

- **基础设施**：AWS (VPC, ECS Fargate, Lambda, RDS, ElastiCache, ALB)
- **API Gateway**：Kong 3.5 (Lua/OpenResty)
- **后端服务**：TypeScript (Node.js, Fastify)
- **数据库**：PostgreSQL 16.6
- **缓存**：Redis
- **前端**：React + Next.js (Studio)
- **IaC**：AWS CDK (TypeScript)
- **容器**：Docker + ECR

### 扩展性考虑

- **水平扩展**：ECS 服务可增加 desired count
- **垂直扩展**：调整 CPU/Memory 配置
- **数据库扩展**：添加更多 Worker RDS 实例
- **Lambda 扩展**：自动并发扩展
- **缓存扩展**：Redis 集群模式

### 未来改进方向

1. **认证服务**：集成 GoTrue (Supabase Auth)
2. **存储服务**：集成 Supabase Storage
3. **实时服务**：集成 Supabase Realtime
4. **连接池**：集成 Supavisor (PostgreSQL connection pooler)
5. **多区域部署**：跨区域高可用
6. **自动扩展**：基于负载的自动扩缩容
7. **成本优化**：Spot instances, Reserved instances

---

**文档版本**: v1.0.0  
**最后更新**: 2026-02-25  
**维护者**: DevOps Team
