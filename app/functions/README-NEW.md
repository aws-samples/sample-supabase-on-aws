# Supabase Edge Functions Service

Official Supabase Edge Runtime 部署在 AWS ECS，支持通过 HTTP 和 Supabase SDK 调用 Deno 函数。

## 特性

- ✅ **官方 Runtime**: 使用 `public.ecr.aws/supabase/edge-runtime:v1.69.28`
- ✅ **EFS 持久化**: 函数文件存储在 EFS，容器重启后依然存在
- ✅ **动态加载**: Main service 路由器动态加载函数
- ✅ **SDK 兼容**: 完全兼容 Supabase JS SDK
- ✅ **Kong 集成**: 通过 Kong Gateway 路由和 CORS 支持
- ✅ **Service Discovery**: AWS Cloud Map 自动服务发现

## 快速开始

### 部署服务

```bash
cd /Users/yonghs/Downloads/supabase-on-aws-main/app/functions
./deploy.sh
```

### 添加新函数

1. 创建函数文件 `my-function.ts`：

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

serve((req) => {
  return new Response(
    JSON.stringify({message: 'My custom function!'}),
    {headers: {'Content-Type': 'application/json'}}
  )
})
```

2. 部署函数：

```bash
./add-function.sh my-function ./my-function.ts
```

### 测试函数

```bash
# 直接调用
curl https://project-alpha.example.com/functions/my-function

# SDK 路径
curl https://project-alpha.example.com/functions/v1/my-function
```

## 使用 Supabase SDK

```javascript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://project-alpha.example.com',
  'YOUR_ANON_KEY'
)

// 调用函数
const { data, error } = await supabase.functions.invoke('my-function', {
  body: { name: 'World' }
})

console.log(data)
```

## 架构

```
Client → ALB → Kong Gateway → Functions Service (ECS)
                                    ↓
                              Main Service (路由器)
                                    ↓
                              EFS (/home/deno/functions)
                                    ├─ main/
                                    ├─ hello/
                                    └─ your-function/
```

## 目录结构

```
app/functions/
├── deploy.sh              # 部署脚本
├── add-function.sh        # 添加函数脚本
├── DEPLOYMENT.md          # 详细部署文档
└── README.md              # 本文件
```

## 技术栈

- **Runtime**: Deno (Supabase Edge Runtime)
- **镜像**: `public.ecr.aws/supabase/edge-runtime:v1.69.28`
- **存储**: AWS EFS
- **网络**: AWS Cloud Map
- **网关**: Kong Gateway
- **计算**: ECS Fargate (256 CPU, 512 MB)

## 端点

- **Health**: `https://project-alpha.example.com/functions/health`
- **Functions**: `https://project-alpha.example.com/functions/v1/{function-name}`

## 监控

```bash
# 查看日志
aws logs tail /ecs/supabase --since 10m --filter-pattern functions-service --region us-east-1

# 查看服务状态
aws ecs describe-services --cluster <ECS_CLUSTER> --services functions-service --region us-east-1
```

## 文档

详细部署和故障排除文档请查看 [DEPLOYMENT.md](./DEPLOYMENT.md)

## 示例函数

### Hello World

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

serve((req) => {
  return new Response(
    JSON.stringify({message: 'Hello from Supabase!'}),
    {headers: {'Content-Type': 'application/json'}}
  )
})
```

### 带参数的函数

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

serve(async (req) => {
  const { name } = await req.json()
  
  return new Response(
    JSON.stringify({
      message: `Hello, ${name || 'World'}!`,
      timestamp: new Date().toISOString()
    }),
    {headers: {'Content-Type': 'application/json'}}
  )
})
```

## 许可

MIT
