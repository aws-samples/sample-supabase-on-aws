# 子域名路由配置 (Subdomain Routing)

## 📋 功能说明

Kong Gateway 现在支持从子域名自动提取 `project-id` 并将其设置为 `X-Project-ID` header，然后转发到后端服务。

## 🎯 使用场景

### 1. 通过子域名访问 Functions 服务

**访问方式**:
```
https://project-alpha.example.com/functions
```

**行为**:
- Kong 从子域名提取 `project-alpha`
- 自动设置 header: `X-Project-ID: project-alpha`
- 转发到 `functions-service.kong.local:8080/functions`
- Functions 服务接收到 `X-Project-ID: project-alpha`

### 2. 通过主域名 + Header 访问

**访问方式**:
```bash
curl -H "X-Project-ID: project-alpha" \
  https://api.example.com/functions
```

**行为**:
- Kong 检测到 `X-Project-ID` header 已存在
- 直接转发 header 到后端服务
- Functions 服务接收到 `X-Project-ID: project-alpha`

## 🔧 技术实现

### Kong 配置

**文件**: `/app/kong/kong.yml`

```yaml
services:
  - name: functions-service
    url: http://functions-service.kong.local:8080
    routes:
      - name: functions-route
        paths:
          - /functions
        strip_path: false
        # 匹配所有 *.example.com 子域名
        hosts:
          - "*.example.com"
          - "api.example.com"
    plugins:
      # 1. CORS 支持
      - name: cors
        config:
          origins: ["*"]
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

      # 2. 从子域名提取 project-id
      - name: pre-function
        config:
          access:
            - |
              local host = kong.request.get_header("Host")
              local project_id = kong.request.get_header("X-Project-ID")

              if not project_id and host then
                local subdomain = host:match("^([^%.]+)%.example%.com")

                if subdomain and subdomain ~= "api" then
                  kong.service.request.set_header("X-Project-ID", subdomain)
                  kong.log.info("Extracted project-id: ", subdomain)
                end
              elseif project_id then
                kong.service.request.set_header("X-Project-ID", project_id)
              end
```

### 提取逻辑

1. **检查 X-Project-ID header**:
   - 如果已存在，直接转发

2. **从 Host header 提取**:
   - 匹配模式: `([^%.]+)%.example%.com`
   - 提取第一个子域名部分

3. **特殊处理**:
   - `api.example.com`: 不提取 project-id（保持原 header）
   - 其他子域名: 提取为 project-id

## 📝 使用示例

### 示例 1: 子域名访问

```bash
# 请求
curl https://my-project.example.com/functions

# Kong 处理
# 1. 从 Host: my-project.example.com 提取 "my-project"
# 2. 设置 X-Project-ID: my-project
# 3. 转发到 functions-service

# Functions 服务接收
# GET /functions
# Headers: X-Project-ID: my-project

# 响应
{
  "service": "Functions Service",
  "project_id": "my-project",
  "message": "Functions endpoint accessed successfully",
  "method": "GET",
  "path": "/functions"
}
```

### 示例 2: 子域名 + 子路径

```bash
# 请求
curl https://project-alpha.example.com/functions/hello-world

# Kong 处理
# 提取: project-alpha
# 路径: /functions/hello-world (保持不变)

# 响应
{
  "service": "Functions Service",
  "project_id": "project-alpha",
  "method": "GET",
  "path": "/functions/hello-world",
  "subpath": "hello-world"
}
```

### 示例 3: POST 请求

```bash
# 请求
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"name": "test", "value": 123}' \
  https://project-beta.example.com/functions/execute

# 响应
{
  "service": "Functions Service",
  "project_id": "project-beta",
  "method": "POST",
  "path": "/functions/execute",
  "subpath": "execute",
  "request_data": {
    "name": "test",
    "value": 123
  }
}
```

### 示例 4: 主域名 + Header

```bash
# 请求
curl -H "X-Project-ID: custom-project" \
  https://api.example.com/functions

# Kong 处理
# 检测到已有 X-Project-ID header
# 直接转发

# 响应
{
  "service": "Functions Service",
  "project_id": "custom-project",
  "method": "GET",
  "path": "/functions"
}
```

## 🔍 验证和调试

### 1. 查看 Kong 日志

```bash
# 查看 Kong 日志
aws logs tail /ecs/supabase --since 10m \
  --filter-pattern "Extracted project-id" \
  --region us-east-1 \
  --profile <AWS_PROFILE>
```

**预期输出**:
```
Extracted project-id from subdomain: project-alpha
Using existing X-Project-ID: custom-project
```

### 2. 测试不同的子域名

```bash
# Test 1: 简单项目名
curl https://test.example.com/functions

# Test 2: 带连字符的项目名
curl https://my-project-123.example.com/functions

# Test 3: 纯数字项目名
curl https://12345.example.com/functions

# Test 4: API 域名（不应提取 project-id）
curl https://api.example.com/functions
# 预期: 没有 project_id 或者显示为 null
```

### 3. 验证 Functions 服务接收

```bash
# 查看 Functions 服务日志
aws logs tail /ecs/supabase --since 5m \
  --filter-pattern "functions-service" \
  --region us-east-1 \
  --profile <AWS_PROFILE>
```

## 🌐 DNS 配置要求

为了使子域名路由工作，需要配置 DNS：

### 泛域名解析

**DNS 记录**:
```
Type: CNAME
Name: *.example.com
Value: <ALB_DNS_NAME>
TTL: 300
```

**说明**:
- 泛域名 `*` 会匹配所有子域名
- 所有子域名都会解析到同一个 ALB
- Kong 根据 Host header 路由到不同服务

### 测试 DNS 解析

```bash
# 测试泛域名解析
nslookup test-project.example.com
nslookup my-app.example.com
nslookup any-subdomain.example.com

# 预期: 所有子域名都解析到 ALB IP
```

## 📊 路由优先级

Kong 的路由匹配优先级（从高到低）:

1. **完全匹配**: 精确的 host + path 组合
2. **正则匹配**: regex_priority 高的路由
3. **通配符匹配**: `*.example.com`

当前配置:
- `/functions` 路径 + `*.example.com` host
- 任何子域名访问 `/functions` 都会匹配此路由

## 🔒 安全考虑

### 1. Project ID 验证

建议在 Functions 服务中验证 project-id:

```python
@app.route('/functions')
def functions():
    project_id = request.headers.get('X-Project-ID')

    # 验证 project-id 格式
    if not project_id or not is_valid_project_id(project_id):
        return jsonify({"error": "Invalid or missing project ID"}), 400

    # 验证 project-id 是否存在
    if not project_exists(project_id):
        return jsonify({"error": "Project not found"}), 404

    # 处理请求
    return process_request(project_id)
```

### 2. 速率限制

建议为不同 project-id 设置独立的速率限制：

```yaml
# Kong 配置
plugins:
  - name: rate-limiting
    config:
      minute: 100
      policy: local
      header_name: X-Project-ID
```

### 3. 访问控制

可以基于 project-id 实现访问控制：

```lua
-- Kong pre-function
local project_id = kong.request.get_header("X-Project-ID")
local allowed_projects = {"project-alpha", "project-beta"}

if not contains(allowed_projects, project_id) then
  return kong.response.exit(403, {error = "Project not allowed"})
end
```

## 🚀 部署步骤

1. ✅ **更新 Kong 配置** (`kong.yml`)
2. ✅ **重新构建 Kong 镜像**
   ```bash
   ./build-and-push.sh kong
   ```

3. ✅ **部署到 ECS**
   ```bash
   cd ../infra
   cdk deploy SupabaseStack
   ```

4. ⏳ **配置 DNS 泛域名解析**
   - 添加 `*.example.com` CNAME 记录
   - 指向 ALB DNS

5. ⏳ **测试验证**
   ```bash
   curl https://test-project.example.com/functions
   ```

## 📚 相关文档

- [Functions Service README](/app/functions/README.md)
- [Kong Gateway Configuration](/app/kong/kong.yml)
- [API Test Guide](/infra/API_TEST_GUIDE.md)

---

**最后更新**: 2026-02-07
**Kong 版本**: 3.5
**配置文件**: `/app/kong/kong.yml`
