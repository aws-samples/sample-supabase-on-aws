#!/bin/bash

# Supabase Studio 构建和启动脚本
# 用于构建自定义 Studio 镜像并启动所有服务

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置
DOCKER_DIR="docker"
STUDIO_IMAGE="supabase-studio-local:latest"
DOCKERFILE_PATH="apps/studio/Dockerfile"

# 打印带颜色的消息
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_header() {
    echo ""
    echo -e "${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}"
    echo ""
}

# 显示帮助信息
show_help() {
    cat << EOF
🚀 Supabase Studio 构建和启动脚本

使用方法: ./build-and-start.sh [选项]

选项：
  --build-only        只构建镜像，不启动服务
  --no-cache          构建时不使用缓存（完全重新构建）
  --skip-build        跳过构建，直接启动服务
  --stop              停止所有服务
  --restart           重启所有服务
  --status            查看服务状态
  --logs [服务名]     查看日志（不指定服务名则查看所有日志）
  --clean             停止服务并清理容器和卷
  --help, -h          显示此帮助信息

示例：
  ./build-and-start.sh                    # 构建镜像并启动服务
  ./build-and-start.sh --build-only       # 只构建镜像
  ./build-and-start.sh --no-cache         # 完全重新构建并启动
  ./build-and-start.sh --skip-build       # 跳过构建直接启动
  ./build-and-start.sh --logs studio      # 查看 studio 服务日志
  ./build-and-start.sh --stop             # 停止所有服务

EOF
}

# 检查 Docker 是否运行
check_docker() {
    print_info "检查 Docker 环境..."
    if ! docker info > /dev/null 2>&1; then
        print_error "Docker 未运行，请先启动 Docker"
        exit 1
    fi
    print_success "Docker 运行正常"
}

# 检查必要文件
check_files() {
    print_info "检查必要文件..."
    
    if [ ! -f "$DOCKERFILE_PATH" ]; then
        print_error "Dockerfile 不存在: $DOCKERFILE_PATH"
        exit 1
    fi
    
    if [ ! -f "$DOCKER_DIR/docker-compose.yml" ]; then
        print_error "docker-compose.yml 不存在: $DOCKER_DIR/docker-compose.yml"
        exit 1
    fi
    
    if [ ! -f "$DOCKER_DIR/.env" ]; then
        print_warning ".env 文件不存在，将使用默认配置"
    fi
    
    print_success "文件检查完成"
}

# 构建 Studio 镜像
build_studio() {
    local no_cache=$1
    
    print_header "构建 Supabase Studio 镜像"
    
    print_info "镜像名称: $STUDIO_IMAGE"
    print_info "Dockerfile: $DOCKERFILE_PATH"
    
    # 构建参数
    BUILD_ARGS="--target production -t $STUDIO_IMAGE -f $DOCKERFILE_PATH"
    
    if [ "$no_cache" = "true" ]; then
        print_warning "使用 --no-cache 选项，将完全重新构建"
        BUILD_ARGS="$BUILD_ARGS --no-cache"
    fi
    
    print_info "开始构建..."
    echo ""
    
    # 执行构建
    if docker build $BUILD_ARGS .; then
        echo ""
        print_success "镜像构建成功: $STUDIO_IMAGE"
        
        # 显示镜像信息
        print_info "镜像信息:"
        docker images $STUDIO_IMAGE --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"
    else
        echo ""
        print_error "镜像构建失败"
        exit 1
    fi
}

# 启动服务
start_services() {
    print_header "启动 Supabase 服务"
    
    cd "$DOCKER_DIR"
    
    print_info "启动所有服务..."
    if docker compose up -d; then
        echo ""
        print_success "服务启动成功"
        echo ""
        print_info "🌐 访问地址："
        echo "   - Supabase Studio: http://localhost:3000"
        echo "   - API Gateway:      http://localhost:8000"
        echo "   - Database:         localhost:5432"
        echo "   - Analytics:        http://localhost:4000"
        echo ""
        print_info "💡 提示："
        echo "   - 查看日志: ./build-and-start.sh --logs"
        echo "   - 查看状态: ./build-and-start.sh --status"
        echo "   - 停止服务: ./build-and-start.sh --stop"
    else
        print_error "服务启动失败"
        exit 1
    fi
    
    cd - > /dev/null
}

# 停止服务
stop_services() {
    print_header "停止 Supabase 服务"
    
    cd "$DOCKER_DIR"
    
    if docker compose down; then
        print_success "服务已停止"
    else
        print_error "停止服务失败"
        exit 1
    fi
    
    cd - > /dev/null
}

# 重启服务
restart_services() {
    print_header "重启 Supabase 服务"
    
    cd "$DOCKER_DIR"
    
    if docker compose restart; then
        print_success "服务已重启"
    else
        print_error "重启服务失败"
        exit 1
    fi
    
    cd - > /dev/null
}

# 查看服务状态
show_status() {
    print_header "Supabase 服务状态"
    
    cd "$DOCKER_DIR"
    docker compose ps
    cd - > /dev/null
}

# 查看日志
show_logs() {
    local service=$1
    
    cd "$DOCKER_DIR"
    
    if [ -z "$service" ]; then
        print_info "查看所有服务日志（Ctrl+C 退出）..."
        docker compose logs -f
    else
        print_info "查看 $service 服务日志（Ctrl+C 退出）..."
        docker compose logs -f "$service"
    fi
    
    cd - > /dev/null
}

# 清理服务和数据
clean_all() {
    print_header "清理 Supabase 服务"
    
    print_warning "此操作将停止所有服务并删除容器和数据卷"
    read -p "确定要继续吗？(yes/no) " -r
    echo ""
    
    if [[ $REPLY == "yes" ]]; then
        cd "$DOCKER_DIR"
        
        print_info "停止并清理所有容器和数据..."
        if docker compose down -v --remove-orphans; then
            print_success "清理完成"
        else
            print_error "清理失败"
            exit 1
        fi
        
        cd - > /dev/null
    else
        print_info "已取消"
    fi
}

# 主函数
main() {
    local build_only=false
    local no_cache=false
    local skip_build=false
    local action="build_and_start"
    local log_service=""
    
    # 解析参数
    while [[ $# -gt 0 ]]; do
        case $1 in
            --build-only)
                build_only=true
                action="build"
                shift
                ;;
            --no-cache)
                no_cache=true
                shift
                ;;
            --skip-build)
                skip_build=true
                action="start"
                shift
                ;;
            --stop)
                action="stop"
                shift
                ;;
            --restart)
                action="restart"
                shift
                ;;
            --status)
                action="status"
                shift
                ;;
            --logs)
                action="logs"
                if [[ $# -gt 1 && ! $2 =~ ^-- ]]; then
                    log_service=$2
                    shift
                fi
                shift
                ;;
            --clean)
                action="clean"
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                print_error "未知选项: $1"
                echo ""
                show_help
                exit 1
                ;;
        esac
    done
    
    # 执行操作
    case $action in
        build)
            check_docker
            check_files
            build_studio "$no_cache"
            ;;
        start)
            check_docker
            check_files
            start_services
            ;;
        build_and_start)
            check_docker
            check_files
            build_studio "$no_cache"
            echo ""
            start_services
            ;;
        stop)
            stop_services
            ;;
        restart)
            restart_services
            ;;
        status)
            show_status
            ;;
        logs)
            show_logs "$log_service"
            ;;
        clean)
            clean_all
            ;;
    esac
}

# 运行主函数
main "$@"
