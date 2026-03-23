#!/bin/bash
set -e

# 配置 - 从 config.json 读取 region（与根目录 build-and-push.sh 一致）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../../config.json"
if [ -f "$CONFIG_FILE" ]; then
  AWS_REGION=$(jq -r '.project.region' "$CONFIG_FILE")
else
  AWS_REGION="${AWS_REGION:-us-east-1}"
fi
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO_NAME="postgrest-lambda"
IMAGE_TAG="v14.1-lambda"

echo "=========================================="
echo "构建 PostgREST Lambda 镜像"
echo "=========================================="
echo "AWS Account: $AWS_ACCOUNT_ID"
echo "Region: $AWS_REGION"
echo "ECR Repo: $ECR_REPO_NAME"
echo "Image Tag: $IMAGE_TAG"
echo ""

# 登录 AWS Public ECR
echo "🔐 登录 AWS Public ECR..."
aws ecr-public get-login-password --region us-east-1 | \
    docker login --username AWS --password-stdin public.ecr.aws

# 创建 ECR 仓库（如果不存在）
echo "📦 创建 ECR 仓库..."
aws ecr describe-repositories --repository-names $ECR_REPO_NAME --region $AWS_REGION 2>/dev/null || \
aws ecr create-repository \
    --repository-name $ECR_REPO_NAME \
    --region $AWS_REGION \
    --image-scanning-configuration scanOnPush=true

# 登录私有 ECR
echo "🔐 登录私有 ECR..."
aws ecr get-login-password --region $AWS_REGION | \
    docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# 构建镜像（x86_64）
echo "🏗️  构建 x86_64 镜像..."
docker build \
    --platform linux/amd64 \
    -t $ECR_REPO_NAME:$IMAGE_TAG \
    -t $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:$IMAGE_TAG \
    -t $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:latest \
    .

# 推送到 ECR
echo "⬆️  推送镜像到 ECR..."
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:$IMAGE_TAG
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:latest

echo ""
echo "=========================================="
echo "✅ 镜像构建并推送成功！"
echo "=========================================="
echo "镜像 URI:"
echo "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:$IMAGE_TAG"
echo ""
echo "使用此镜像创建 Lambda 函数："
echo "aws lambda create-function \\"
echo "  --function-name postgrest-api \\"
echo "  --package-type Image \\"
echo "  --code ImageUri=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:$IMAGE_TAG \\"
echo "  --role arn:aws:iam::$AWS_ACCOUNT_ID:role/lambda-execution-role \\"
echo "  --timeout 30 \\"
echo "  --memory-size 512 \\"
echo "  --environment Variables='{PGRST_DB_URI=postgresql://...,PGRST_DB_SCHEMAS=public,PGRST_DB_ANON_ROLE=anon,PGRST_JWT_SECRET=your-secret}'"
