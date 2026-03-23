#!/bin/bash

# 构建并推送应用服务镜像到 ECR
# 支持的服务: functions, kong, postgrest-lambda, tenant-manager, postgres-meta, studio

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 从 config.json 读取配置（单一事实源）
CONFIG_FILE="$SCRIPT_DIR/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "错误: 配置文件不存在: $CONFIG_FILE"
    exit 1
fi
AWS_ACCOUNT_ID=$(jq -r '.project.accountId' "$CONFIG_FILE")
AWS_REGION="${AWS_REGION:-$(jq -r '.project.region' "$CONFIG_FILE")}"

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "========================================="
echo "应用服务镜像构建和推送工具"
echo "========================================="
echo "AWS Account ID: $AWS_ACCOUNT_ID"
echo "AWS Region: $AWS_REGION"
echo "AWS Profile: ${AWS_PROFILE:-default}"
echo "Git SHA: $GIT_SHA"
echo "========================================="
echo ""

# 所有可用服务
ALL_SERVICES="functions kong postgrest-lambda tenant-manager postgres-meta studio function-deploy auth"

# 服务配置函数: ECR仓库名|构建上下文目录|Dockerfile路径
get_service_config() {
    local service="$1"
    case "$service" in
        functions)
            echo "functions-service|app/functions|Dockerfile"
            ;;
        kong)
            echo "kong-configured|app/kong|Dockerfile"
            ;;
        postgrest-lambda)
            echo "postgrest-lambda|app/postgrest-lambda|Dockerfile"
            ;;
        tenant-manager)
            echo "tenant-manager|app/tenant-manager|docker/Dockerfile"
            ;;
        postgres-meta)
            echo "postgres-meta|app/postgres-meta|Dockerfile"
            ;;
        studio)
            echo "studio|app/supabase|apps/studio/Dockerfile"
            ;;
        function-deploy)
            echo "function-deploy|app/function-deploy|apps/studio/Dockerfile"
            ;;
        auth)
            echo "auth-service|app/supabase-auth|Dockerfile"
            ;;
        *)
            echo ""
            ;;
    esac
}

# 解析命令行参数
SERVICE_TO_BUILD="$1"

# 确定要构建的服务列表
if [ -n "$SERVICE_TO_BUILD" ] && [ "$SERVICE_TO_BUILD" != "all" ]; then
    if [ -z "$(get_service_config "$SERVICE_TO_BUILD")" ]; then
        echo "错误: 未知的服务 '$SERVICE_TO_BUILD'"
        echo "可用的服务: $ALL_SERVICES"
        exit 1
    fi
    echo "只构建服务: $SERVICE_TO_BUILD"
    SERVICES_TO_BUILD="$SERVICE_TO_BUILD"
else
    echo "构建所有服务"
    SERVICES_TO_BUILD="$ALL_SERVICES"
fi
echo ""

# 切换到项目根目录（确保相对路径正确）
cd "$SCRIPT_DIR"

# ECR 登录（私有）
echo "登录到私有 ECR..."
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
echo "私有 ECR 登录成功"
echo ""

# Public ECR 登录（postgrest-lambda 的基础镜像需要）
echo "登录到 AWS Public ECR..."
aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws
echo "Public ECR 登录成功"
echo ""

# 处理每个服务
for service in $SERVICES_TO_BUILD; do
    echo "========================================="
    echo "处理服务: $service"
    echo "========================================="

    # 获取服务配置
    config=$(get_service_config "$service")
    if [ -z "$config" ]; then
        echo "警告: 无法获取服务配置"
        continue
    fi

    # 解析配置
    repository=$(echo "$config" | cut -d'|' -f1)
    context=$(echo "$config" | cut -d'|' -f2)
    dockerfile=$(echo "$config" | cut -d'|' -f3)

    echo "  Repository: $repository"
    echo "  Context: $context"
    echo "  Dockerfile: $context/$dockerfile"
    echo ""

    # 检查目录是否存在
    if [ ! -d "$context" ]; then
        echo "警告: 目录不存在: $context，跳过此服务"
        echo ""
        continue
    fi

    # 检查 Dockerfile 是否存在
    if [ ! -f "$context/$dockerfile" ]; then
        echo "警告: Dockerfile 不存在: $context/$dockerfile，跳过此服务"
        echo ""
        continue
    fi

    # 检查 ECR 仓库是否存在
    echo "检查 ECR 仓库..."
    if ! aws ecr describe-repositories --repository-names "$repository" --region "$AWS_REGION" &> /dev/null; then
        echo "仓库不存在，创建新仓库: $repository"
        repo_uri=$(aws ecr create-repository \
            --repository-name "$repository" \
            --region "$AWS_REGION" \
            --image-scanning-configuration scanOnPush=true \
            --query 'repository.repositoryUri' \
            --output text)

        echo "  仓库 URI: $repo_uri"

        # 设置生命周期策略
        echo "  设置生命周期策略: 保留 10 个最新镜像"
        aws ecr put-lifecycle-policy \
            --repository-name "$repository" \
            --region "$AWS_REGION" \
            --lifecycle-policy-text '{
                "rules": [{
                    "rulePriority": 1,
                    "description": "Keep only 10 most recent images",
                    "selection": {
                        "tagStatus": "any",
                        "countType": "imageCountMoreThan",
                        "countNumber": 10
                    },
                    "action": {
                        "type": "expire"
                    }
                }]
            }' > /dev/null
    else
        echo "仓库已存在: $repository"
        repo_uri=$(aws ecr describe-repositories \
            --repository-names "$repository" \
            --region "$AWS_REGION" \
            --query 'repositories[0].repositoryUri' \
            --output text)
    fi
    echo ""

    # 构建镜像
    image_uri="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$repository:latest"
    echo "构建镜像 (linux/amd64)..."
    echo "  Image URI: $image_uri"
    echo "  Building from: $context"
    echo ""

    # Copy RDS CA certificate to build context (required for SSL verification)
    CERT_FILE="$SCRIPT_DIR/certs/global-bundle.pem"
    if [ ! -f "$CERT_FILE" ]; then
        echo "错误: RDS CA 证书不存在: $CERT_FILE"
        echo "请下载: curl -o certs/global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem"
        exit 1
    fi
    mkdir -p "$context/certs"
    cp "$CERT_FILE" "$context/certs/global-bundle.pem"

    if docker build --platform linux/amd64 -t "$repository:latest" -f "$context/$dockerfile" "$context"; then
        echo "镜像构建成功"
    else
        echo "镜像构建失败"
        exit 1
    fi
    echo ""

    # 标记镜像
    echo "标记镜像..."
    docker tag "$repository:latest" "$image_uri"
    sha_image_uri="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$repository:$GIT_SHA"
    docker tag "$repository:latest" "$sha_image_uri"
    echo "镜像标记成功 (latest + $GIT_SHA)"
    echo ""

    # 推送镜像
    echo "推送镜像到 ECR..."
    if docker push "$image_uri" && docker push "$sha_image_uri"; then
        echo "镜像推送成功 (latest + $GIT_SHA)"
    else
        echo "镜像推送失败"
        exit 1
    fi
    echo ""

    # Clean up RDS CA certificate from build context
    rm -rf "$context/certs"

    # 获取镜像摘要
    image_digest=$(aws ecr describe-images \
        --repository-name "$repository" \
        --region "$AWS_REGION" \
        --image-ids imageTag=latest \
        --query 'imageDetails[0].imageDigest' \
        --output text 2>/dev/null || echo "unknown")

    echo "服务 $service 处理完成"
    echo "  Image URI: $image_uri"
    echo "  Image Digest: $image_digest"
    echo ""
done

echo "========================================="
echo "所有镜像构建和推送完成！"
echo "========================================="
echo ""

# 列出所有镜像
echo "ECR 镜像列表:"
for service in $SERVICES_TO_BUILD; do
    config=$(get_service_config "$service")
    repository=$(echo "$config" | cut -d'|' -f1)

    echo ""
    echo "Repository: $repository"
    aws ecr describe-images \
        --repository-name "$repository" \
        --region "$AWS_REGION" \
        --query 'imageDetails[*].[imageTags[0],imagePushedAt,imageSizeInBytes]' \
        --output table 2>/dev/null || echo "  仓库为空或不存在"
done

echo ""
echo "========================================="
echo "使用说明"
echo "========================================="
echo "构建所有服务:"
echo "  ./build-and-push.sh"
echo "  ./build-and-push.sh all"
echo ""
echo "构建单个服务:"
echo "  ./build-and-push.sh functions"
echo "  ./build-and-push.sh kong"
echo "  ./build-and-push.sh postgrest-lambda"
echo "  ./build-and-push.sh tenant-manager"
echo ""
echo "完成！"
