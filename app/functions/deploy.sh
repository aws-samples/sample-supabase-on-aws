#!/bin/bash
set -e

# Supabase Edge Functions 部署脚本
# 使用官方 edge-runtime 镜像和 EFS 持久化存储

REGION="${AWS_REGION:-us-east-1}"
CLUSTER="${ECS_CLUSTER:-infrastack-cluster}"
SERVICE="functions-service"
TASK_FAMILY=""
EFS_ID="<your-efs-id>"
SECURITY_GROUP="<your-security-group-id>"
EXECUTION_ROLE="<your-execution-role-arn>"
TASK_ROLE="<your-task-role-arn>"

echo "🚀 Supabase Edge Functions Deployment"
echo "======================================"

# 创建任务定义
echo "📝 Creating task definition..."
cat > /tmp/functions-task-def.json << 'EOF'
{
  "family": "",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::",
  "taskRoleArn": "arn:aws:iam::",
  "containerDefinitions": [
    {
      "name": "functions-service",
      "image": "public.ecr.aws/supabase/edge-runtime:v1.69.28",
      "essential": true,
      "portMappings": [{"containerPort": 8080, "protocol": "tcp"}],
      "entryPoint": ["/bin/sh", "-c"],
      "command": ["mkdir -p /home/deno/functions/main && cat > /home/deno/functions/main/index.ts << 'MAINEOF'\nimport { serve } from \"https://deno.land/std@0.168.0/http/server.ts\"\nserve(async (req) => {\n  let path = new URL(req.url).pathname\n  if (path.startsWith('/functions/')) path = path.substring(11)\n  if (path.startsWith('v1/')) path = path.substring(3)\n  path = path.split(\"/\").filter(x => x).join(\"/\")\n  if (path === \"health\") return new Response(JSON.stringify({status:\"ok\"}), {headers:{\"Content-Type\":\"application/json\"}})\n  if (!path) return new Response(JSON.stringify({msg:\"missing function\"}), {status:400, headers:{\"Content-Type\":\"application/json\"}})\n  const servicePath = `/home/deno/functions/${path}`\n  console.error(`Loading:${servicePath}`)\n  try {\n    const worker = await EdgeRuntime.userWorkers.create({\n      servicePath,\n      memoryLimitMb: 150,\n      workerTimeoutMs: 60000,\n      noModuleCache: false,\n      importMapPath: null,\n      envVars: Object.entries(Deno.env.toObject())\n    })\n    return await worker.fetch(req)\n  } catch (e) {\n    return new Response(JSON.stringify({msg: e.toString()}), {status:500, headers:{\"Content-Type\":\"application/json\"}})\n  }\n})\nMAINEOF\necho 'Main service created' && edge-runtime start --main-service /home/deno/functions/main -p 9999"],
      "environment": [
        {"name": "FUNCTIONS_VERIFY_JWT", "value": "false"}
      ],
      "mountPoints": [
        {
          "sourceVolume": "functions-volume",
          "containerPath": "/home/deno/functions",
          "readOnly": false
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/supabase",
          "awslogs-region": "$REGION",
          "awslogs-stream-prefix": "functions-service"
        }
      }
    }
  ],
  "volumes": [
    {
      "name": "functions-volume",
      "efsVolumeConfiguration": {
        "fileSystemId": "<your-efs-id>",
        "rootDirectory": "/",
        "transitEncryption": "ENABLED"
      }
    }
  ]
}
EOF

# 注册任务定义
echo "📦 Registering task definition..."
REVISION=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/functions-task-def.json \
  --region $REGION | jq -r '.taskDefinition.revision')

echo "✅ Task definition registered: $TASK_FAMILY:$REVISION"

# 更新服务
echo "🔄 Updating ECS service..."
aws ecs update-service \
  --cluster $CLUSTER \
  --service $SERVICE \
  --task-definition $TASK_FAMILY:$REVISION \
  --force-new-deployment \
  --region $REGION > /dev/null

echo "✅ Service update initiated"

# 等待部署
echo "⏳ Waiting for deployment (50 seconds)..."
sleep 50

# 测试
echo "🧪 Testing deployment..."
echo ""
echo "Testing health endpoint:"
curl -s https://<your-project-ref>.<your-base-domain>/functions/health | jq .

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📚 Available endpoints:"
echo "  - Health: https://<your-project-ref>.<your-base-domain>/functions/health"
echo "  - Functions: https://<your-project-ref>.<your-base-domain>/functions/v1/{function-name}"
echo ""
echo "📖 View logs:"
echo "  aws logs tail /ecs/supabase --since 5m --filter-pattern functions-service --region $REGION"
