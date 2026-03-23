# Kong Gateway Service

Kong API Gateway 配置为 DB-less 模式，使用声明式配置文件管理路由。

## 服务信息

- **Proxy 端口**: 8000
- **Admin API 端口**: 8001 (仅内部访问)
- **配置模式**: DB-less (声明式配置)

## 文件说明

- `kong.yml` - Kong 声明式配置文件
- `Dockerfile` - Docker 镜像构建文件
- `build-push.sh` - 构建并推送镜像到 ECR 的脚本
- `README.md` - 本文件

## Kong 配置 (kong.yml)

当前配置包含以下服务和路由：

### hello-api 服务
- **上游 URL**: http://hello-api.kong.local:8080
- **路由路径**: /hello
- **Strip Path**: false (保留完整路径)

### 配置示例
```yaml
_format_version: "3.0"
_transform: true

services:
  - name: hello-api
    url: http://hello-api.kong.local:8080
    routes:
      - name: hello-route
        paths:
          - /hello
        strip_path: false
```

## 添加新路由

### 1. 编辑 kong.yml
```yaml
services:
  - name: your-service
    url: http://your-service.kong.local:8080
    routes:
      - name: your-route
        paths:
          - /api/your-path
        strip_path: true
```

### 2. 重新构建并推送
```bash
./build-push.sh
```

### 3. 重启 Kong 服务
```bash
aws ecs update-service \
  --cluster kong-gateway-cluster \
  --service kong-gateway \
  --force-new-deployment \
  --region us-east-1
```

## 路由配置说明

### strip_path 参数
- `strip_path: true` - 转发时去掉路由路径
  - 请求: `/api/hello` → 转发: `/`
- `strip_path: false` - 转发时保留完整路径
  - 请求: `/hello` → 转发: `/hello`

### 示例场景

#### 场景 1: 上游服务有根路径 API
```yaml
services:
  - name: api-service
    url: http://api.example.com
    routes:
      - name: api-route
        paths:
          - /api
        strip_path: true
```
请求 `/api/users` → 转发到 `http://api.example.com/users`

#### 场景 2: 上游服务有特定路径
```yaml
services:
  - name: hello-api
    url: http://hello-api.kong.local:8080
    routes:
      - name: hello-route
        paths:
          - /hello
        strip_path: false
```
请求 `/hello` → 转发到 `http://hello-api.kong.local:8080/hello`

## 本地测试

### 启动 Kong (使用 Docker)
```bash
docker run -d --name kong \
  -p 8000:8000 \
  -p 8001:8001 \
  -e "KONG_DATABASE=off" \
  -e "KONG_DECLARATIVE_CONFIG=/tmp/kong.yml" \
  -e "KONG_PROXY_ACCESS_LOG=/dev/stdout" \
  -e "KONG_ADMIN_ACCESS_LOG=/dev/stdout" \
  -e "KONG_PROXY_ERROR_LOG=/dev/stderr" \
  -e "KONG_ADMIN_ERROR_LOG=/dev/stderr" \
  -v $(pwd)/kong.yml:/tmp/kong.yml \
  kong:3.5
```

### 测试路由
```bash
# 测试 hello-api 路由
curl http://localhost:8000/hello

# 查看 Kong 状态 (DB-less 模式下 Admin API 功能有限)
curl http://localhost:8001/status
```

## 构建并推送

### 使用脚本
```bash
./build-push.sh
```

### 手动构建
```bash
# 登录 ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com

# 构建镜像
docker buildx build --platform linux/amd64 -t kong-configured:latest . --load

# 标记并推送
docker tag kong-configured:latest <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/kong-configured:latest
docker push <AWS_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/kong-configured:latest
```

## 部署到 ECS

推送新镜像后，强制重启 Kong 服务：

```bash
aws ecs update-service \
  --cluster kong-gateway-cluster \
  --service kong-gateway \
  --force-new-deployment \
  --region us-east-1
```

等待约 1-2 分钟，新配置将生效。

## 环境变量

Kong 使用以下环境变量（在 ECS Task Definition 中配置）：

- `KONG_DATABASE=off` - 启用 DB-less 模式
- `KONG_DECLARATIVE_CONFIG=/tmp/kong.yml` - 配置文件路径
- `KONG_PROXY_ACCESS_LOG=/dev/stdout` - Proxy 访问日志
- `KONG_ADMIN_ACCESS_LOG=/dev/stdout` - Admin 访问日志
- `KONG_PROXY_ERROR_LOG=/dev/stderr` - Proxy 错误日志
- `KONG_ADMIN_ERROR_LOG=/dev/stderr` - Admin 错误日志
- `KONG_ADMIN_LISTEN=0.0.0.0:8001` - Admin API 监听地址

## 故障排查

### 查看 Kong 日志
```bash
aws logs tail /ecs/kong-gateway --follow --region us-east-1
```

### 验证路由配置
DB-less 模式下无法通过 Admin API 查询路由，建议：
1. 检查 kong.yml 语法
2. 查看容器启动日志
3. 测试实际路由是否工作

### 常见问题

**502 Bad Gateway**
- 检查上游服务是否正常运行
- 验证 Service Discovery DNS 解析
- 确认 Security Group 规则允许 Kong 访问上游服务

**404 Not Found**
- 检查路由路径配置
- 验证 strip_path 设置
- 确认上游服务的实际端点路径

## Kong 版本

当前使用 Kong 3.5 版本。
