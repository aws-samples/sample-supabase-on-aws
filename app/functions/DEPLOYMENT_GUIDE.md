# Functions Service 部署指南

## 📋 概述

本文档说明如何构建、打包、发布 Functions Service，并更新 ECS Task。

## 🔧 前提条件

### 1. 环境要求

- Docker 已安装并运行
- AWS CLI 已配置（profile: `<AWS_PROFILE>`）
- 有 ECR 仓库的推送权限
- 有 ECS 服务的更新权限

### 2. AWS 资源信息

```bash
AWS Account: <AWS_ACCOUNT_ID>
AWS Region: us-east-1
ECR Repository: functions-service
ECR URI: <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/functions-service
ECS Cluster: <ECS_CLUSTER>
ECS Service: functions-service
```

### 3. 验证 AWS 配置

```bash
# 验证 AWS 配置
aws sts get-caller-identity --profile <AWS_PROFILE>

# 预期输出
# {
#     "UserId": "...",
#     "Account": "<AWS_ACCOUNT_ID>",
#     "Arn": "..."
# }
```

## 📦 部署步骤

### 方法一：使用统一构建脚本（推荐）

项目提供了统一的构建脚本，可以自动完成构建和推送。

#### 1. 使用构建脚本

```bash
# 进入项目根目录
cd ~/supabase-on-aws

# 构建并推送 Functions Service
./app/build-and-push.sh functions
```

脚本会自动完成：
- ECR 登录
- Docker 镜像构建（linux/amd64 平台）
- 推送到 ECR
- 显示最新镜像信息

#### 2. 强制更新 ECS Service

```bash
# 方式 A：使用 AWS CLI
export AWS_PROFILE=<AWS_PROFILE>

aws ecs update-service \
  --cluster <ECS_CLUSTER> \
  --service functions-service \
  --force-new-deployment \
  --region us-east-1

# 方式 B：使用 CDK 重新部署
cd infra
cdk deploy SupabaseStack --require-approval never
```

#### 3. 监控部署状态

```bash
# 查看服务状态
aws ecs describe-services \
  --cluster <ECS_CLUSTER> \
  --services functions-service \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'services[0].[serviceName,status,runningCount,desiredCount,deployments[0].rolloutState]' \
  --output table

# 预期输出（部署完成后）
# ----------------------------------------
# |         DescribeServices            |
# +--------------------+-------+---+---+
# |  functions-service | ACTIVE| 1 | 1 |
# |  COMPLETED         |       |   |   |
# +--------------------+-------+---+---+
```

### 方法二：手动构建和推送

如果需要更精细的控制，可以手动执行每个步骤。

#### 1. 登录到 ECR

```bash
export AWS_PROFILE=<AWS_PROFILE>
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=<AWS_ACCOUNT_ID>

# 登录 ECR
aws ecr get-login-password --region $AWS_REGION --profile $AWS_PROFILE | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
```

#### 2. 构建 Docker 镜像

```bash
# 进入 functions 目录
cd ~/supabase-on-aws/app/functions

# 构建镜像（指定 linux/amd64 平台）
docker build --platform linux/amd64 -t functions-service:latest .

# 验证镜像已创建
docker images | grep functions-service
```

#### 3. 标记并推送镜像

```bash
# 标记镜像
docker tag functions-service:latest \
  <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/functions-service:latest

# 推送到 ECR
docker push <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/functions-service:latest
```

#### 4. 验证镜像已推送

```bash
# 查看 ECR 仓库中的镜像
aws ecr describe-images \
  --repository-name functions-service \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'sort_by(imageDetails,& imagePushedAt)[-1].[imageTags[0],imageDigest,imagePushedAt]' \
  --output table
```

#### 5. 更新 ECS Service

```bash
# 强制更新 ECS Service（拉取最新镜像）
aws ecs update-service \
  --cluster <ECS_CLUSTER> \
  --service functions-service \
  --force-new-deployment \
  --region us-east-1 \
  --profile <AWS_PROFILE>
```

## 🔍 部署验证

### 1. 检查 Task 状态

```bash
# 查看正在运行的任务
aws ecs list-tasks \
  --cluster <ECS_CLUSTER> \
  --service-name functions-service \
  --region us-east-1 \
  --profile <AWS_PROFILE>

# 获取 Task ARN 并查看详情
TASK_ARN=$(aws ecs list-tasks \
  --cluster <ECS_CLUSTER> \
  --service-name functions-service \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'taskArns[0]' \
  --output text)

aws ecs describe-tasks \
  --cluster <ECS_CLUSTER> \
  --tasks $TASK_ARN \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'tasks[0].[lastStatus,healthStatus,containers[0].image]' \
  --output table
```

### 2. 检查容器日志

```bash
# 查看最近 10 分钟的日志
aws logs tail /ecs/supabase \
  --since 10m \
  --filter-pattern "functions-service" \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --follow
```

### 3. 测试 API 端点

```bash
# 测试健康检查
curl https://api.example.com/functions/health

# 预期响应
# {
#   "status": "healthy",
#   "service": "Functions Service",
#   "timestamp": "2026-02-07..."
# }

# 测试 Functions 端点（带 X-Project-ID header）
curl -H "X-Project-ID: test-project" \
  https://api.example.com/functions

# 预期响应
# {
#   "service": "Functions Service",
#   "message": "Functions endpoint accessed successfully",
#   "project_id": "test-project",
#   "method": "GET",
#   "path": "/functions",
#   "timestamp": "2026-02-07..."
# }

# 测试子域名路由（推荐方式 - DNS 已配置）
curl https://project-alpha.example.com/functions

# 预期响应（project_id 自动从子域名提取）
# {
#   "message": "Functions endpoint accessed successfully",
#   "method": "GET",
#   "path": "/functions",
#   "project_id": "project-alpha",
#   "service": "Functions Service",
#   "timestamp": "2026-02-07 05:08:14.645021"
# }

# 测试不同的 project-id
curl https://my-project-123.example.com/functions
curl https://test-app.example.com/functions

# 测试子域名路由 + 子路径
curl https://project-alpha.example.com/functions/hello-world

# 预期响应（包含 subpath）
# {
#   "message": "Functions endpoint accessed successfully",
#   "method": "GET",
#   "path": "/functions/hello-world",
#   "project_id": "project-alpha",
#   "service": "Functions Service",
#   "subpath": "hello-world",
#   "timestamp": "2026-02-07..."
# }

# 测试 POST 请求（子域名路由）
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"function": "hello", "data": "test"}' \
  https://project-beta.example.com/functions/execute

# 预期响应（包含 request_data）
# {
#   "message": "Functions endpoint accessed successfully",
#   "method": "POST",
#   "path": "/functions/execute",
#   "project_id": "project-beta",
#   "request_data": {
#     "function": "hello",
#     "data": "test"
#   },
#   "service": "Functions Service",
#   "subpath": "execute",
#   "timestamp": "2026-02-07..."
# }
```

## 🐛 故障排除

### 问题 1：Task 无法启动

**症状**：ECS Task 一直处于 PENDING 或 STOPPED 状态

**排查步骤**：

```bash
# 1. 查看 Task 失败原因
aws ecs describe-tasks \
  --cluster <ECS_CLUSTER> \
  --tasks $TASK_ARN \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'tasks[0].stoppedReason'

# 2. 检查容器日志
aws logs tail /ecs/supabase \
  --since 30m \
  --filter-pattern "functions-service" \
  --region us-east-1 \
  --profile <AWS_PROFILE>
```

**常见原因**：
- ECR 镜像拉取失败：检查 ECR 权限和镜像是否存在
- 健康检查失败：确认应用在容器内正常启动
- 资源不足：检查 ECS 集群容量

### 问题 2：健康检查失败

**症状**：Task 启动后很快被终止

**排查步骤**：

```bash
# 查看健康检查配置
aws ecs describe-task-definition \
  --task-definition functions-service \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'taskDefinition.containerDefinitions[0].healthCheck'
```

**解决方案**：
- 确认 `/health` 端点返回 200 状态码
- 检查应用启动时间是否超过健康检查间隔
- 查看容器日志确认应用正常运行

### 问题 3：Kong 无法路由到 Functions Service

**症状**：API 请求返回 503 或超时

**排查步骤**：

```bash
# 1. 检查 Service Discovery
aws servicediscovery list-services \
  --region us-east-1 \
  --profile <AWS_PROFILE>

# 2. 验证 Kong 可以解析 functions-service.kong.local
# 进入 Kong 容器
KONG_TASK=$(aws ecs list-tasks \
  --cluster <ECS_CLUSTER> \
  --service-name kong-gateway \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'taskArns[0]' \
  --output text)

# 3. 查看 Kong 日志
aws logs tail /ecs/supabase \
  --since 10m \
  --filter-pattern "kong" \
  --region us-east-1 \
  --profile <AWS_PROFILE>
```

**解决方案**：
- 确认 Security Group 允许 Kong → Functions Service (端口 8080)
- 重启 Kong 服务以重新加载配置
- 验证 Service Discovery DNS 记录

### 问题 4：代码更新未生效

**症状**：部署后 API 行为没有改变

**排查步骤**：

```bash
# 1. 验证 ECR 中的镜像确实是最新的
aws ecr describe-images \
  --repository-name functions-service \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'sort_by(imageDetails,& imagePushedAt)[-1].[imagePushedAt,imageDigest]' \
  --output table

# 2. 检查 Task 使用的镜像
aws ecs describe-tasks \
  --cluster <ECS_CLUSTER> \
  --tasks $TASK_ARN \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'tasks[0].containers[0].[image,imageDigest]' \
  --output table
```

**解决方案**：
- 确认镜像推送成功（检查推送时间）
- 强制重新部署 ECS Service：`--force-new-deployment`
- 等待旧 Task 完全停止，新 Task 启动

## 📊 部署检查清单

使用此检查清单确保部署成功：

- [ ] Docker 镜像构建成功
- [ ] 镜像成功推送到 ECR
- [ ] ECR 中的镜像 digest 已更新
- [ ] ECS Service 触发了新部署
- [ ] 新 Task 成功启动
- [ ] Task 健康检查通过
- [ ] 旧 Task 已停止
- [ ] Service 状态为 ACTIVE
- [ ] RunningCount = DesiredCount
- [ ] Rollout State = COMPLETED
- [ ] `/health` 端点返回 200
- [ ] `/functions` 端点正常响应（使用 X-Project-ID header）
- [ ] 子域名路由正常工作（`curl https://project-alpha.example.com/functions`）
- [ ] 子域名中的 project_id 正确提取
- [ ] 容器日志无错误

## 🔄 回滚步骤

如果新版本有问题，需要回滚到之前的版本：

```bash
# 1. 查看之前的镜像版本
aws ecr describe-images \
  --repository-name functions-service \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'sort_by(imageDetails,& imagePushedAt)[-5:].[imagePushedAt,imageDigest]' \
  --output table

# 2. 标记旧版本为 latest
OLD_DIGEST="sha256:xxxxx"  # 从上面获取

aws ecr batch-get-image \
  --repository-name functions-service \
  --image-ids imageDigest=$OLD_DIGEST \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query 'images[0].imageManifest' \
  --output text | \
aws ecr put-image \
  --repository-name functions-service \
  --image-tag latest \
  --image-manifest fileb:///dev/stdin \
  --region us-east-1 \
  --profile <AWS_PROFILE>

# 3. 强制重新部署
aws ecs update-service \
  --cluster <ECS_CLUSTER> \
  --service functions-service \
  --force-new-deployment \
  --region us-east-1 \
  --profile <AWS_PROFILE>
```

## 📝 开发工作流

### 本地开发和测试

```bash
# 1. 进入 functions 目录
cd ~/supabase-on-aws/app/functions

# 2. 安装依赖
pip3 install -r requirements.txt

# 3. 本地运行
python3 app.py

# 4. 在另一个终端测试
curl http://localhost:8080/health
curl -H "X-Project-ID: test" http://localhost:8080/functions
```

### 代码修改后的完整流程

```bash
# 1. 修改代码
vim app.py

# 2. 本地测试
python3 app.py &
sleep 2
curl http://localhost:8080/health
kill %1

# 3. 构建并推送新镜像
cd ~/supabase-on-aws
./app/build-and-push.sh functions

# 4. 更新 ECS Service
export AWS_PROFILE=<AWS_PROFILE>
aws ecs update-service \
  --cluster <ECS_CLUSTER> \
  --service functions-service \
  --force-new-deployment \
  --region us-east-1

# 5. 监控部署
watch -n 5 'aws ecs describe-services \
  --cluster <ECS_CLUSTER> \
  --services functions-service \
  --region us-east-1 \
  --profile <AWS_PROFILE> \
  --query "services[0].[serviceName,runningCount,deployments[0].rolloutState]" \
  --output table'

# 6. 测试新版本
curl https://api.example.com/functions/health

# 测试子域名路由（推荐）
curl https://project-alpha.example.com/functions

# 预期看到 project_id: "project-alpha"

# 7. 提交代码
git add .
git commit -m "Update functions service"
git push
```

## 📚 相关文档

- [Functions Service README](./README.md) - 服务功能说明
- [Kong 子域名路由配置](../kong/SUBDOMAIN_ROUTING.md) - 路由配置详情
- [API 测试指南](/infra/API_TEST_GUIDE.md) - API 测试方法
- [构建脚本说明](../build-and-push.sh) - 统一构建脚本使用

## 🆘 获取帮助

如遇到问题，请提供以下信息：

1. **错误描述**：具体的错误信息或异常行为
2. **部署日志**：CDK 部署输出或 AWS CLI 命令输出
3. **容器日志**：
   ```bash
   aws logs tail /ecs/supabase --since 30m \
     --filter-pattern "functions-service" \
     --region us-east-1 --profile <AWS_PROFILE>
   ```
4. **Task 状态**：
   ```bash
   aws ecs describe-tasks --cluster <ECS_CLUSTER> \
     --tasks $TASK_ARN --region us-east-1 --profile <AWS_PROFILE>
   ```
5. **镜像信息**：
   ```bash
   aws ecr describe-images --repository-name functions-service \
     --region us-east-1 --profile <AWS_PROFILE>
   ```

---

**最后更新**: 2026-02-07
**维护者**: DevOps Team
**版本**: v1.0.0
