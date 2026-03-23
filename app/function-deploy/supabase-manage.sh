#!/bin/bash

# Supabase Docker 管理脚本

DOCKER_DIR="docker"

show_help() {
    echo "🚀 Supabase Docker 管理脚本"
    echo "=========================="
    echo ""
    echo "使用方法: ./supabase-manage.sh [命令]"
    echo ""
    echo "命令："
    echo "  start       - 启动所有服务"
    echo "  stop        - 停止所有服务"
    echo "  restart     - 重启所有服务"
    echo "  status      - 查看服务状态"
    echo "  logs        - 查看所有服务日志"
    echo "  logs [服务] - 查看指定服务日志"
    echo "  clean       - 停止并删除所有容器和卷（⚠️ 会删除数据）"
    echo "  reset       - 完全重置（停止、清理、重新启动）"
    echo "  help        - 显示此帮助信息"
    echo ""
    echo "示例："
    echo "  ./supabase-manage.sh start"
    echo "  ./supabase-manage.sh logs studio"
    echo "  ./supabase-manage.sh status"
}

start_services() {
    echo "🚀 启动 Supabase 服务..."
    cd "$DOCKER_DIR"
    docker compose up -d
    echo ""
    echo "✅ 服务已启动"
    echo ""
    echo "🌐 访问地址："
    echo "   - Supabase Studio: http://localhost:3000"
    echo "   - API Gateway:      http://localhost:8000"
    echo "   - Database:         localhost:5432"
    echo "   - Analytics:        http://localhost:4000"
}

stop_services() {
    echo "🛑 停止 Supabase 服务..."
    cd "$DOCKER_DIR"
    docker compose down
    echo "✅ 服务已停止"
}

restart_services() {
    echo "🔄 重启 Supabase 服务..."
    cd "$DOCKER_DIR"
    docker compose restart
    echo "✅ 服务已重启"
}

show_status() {
    echo "📊 Supabase 服务状态"
    echo "===================="
    echo ""
    cd "$DOCKER_DIR"
    docker compose ps
}

show_logs() {
    cd "$DOCKER_DIR"
    if [ -z "$1" ]; then
        echo "📚 查看所有服务日志（Ctrl+C 退出）..."
        docker compose logs -f
    else
        echo "📚 查看 $1 服务日志（Ctrl+C 退出）..."
        docker compose logs -f "$1"
    fi
}

clean_all() {
    echo "⚠️  警告: 此操作将删除所有容器和数据卷！"
    read -p "确定要继续吗？(yes/no) " -r
    echo ""
    if [[ $REPLY == "yes" ]]; then
        echo "🧹 清理所有容器和数据..."
        cd "$DOCKER_DIR"
        docker compose down -v --remove-orphans
        echo "✅ 清理完成"
    else
        echo "已取消"
    fi
}

reset_all() {
    echo "🔄 完全重置 Supabase..."
    clean_all
    if [[ $REPLY == "yes" ]]; then
        echo ""
        start_services
    fi
}

# 主逻辑
case "$1" in
    start)
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
        show_logs "$2"
        ;;
    clean)
        clean_all
        ;;
    reset)
        reset_all
        ;;
    help|--help|-h|"")
        show_help
        ;;
    *)
        echo "❌ 未知命令: $1"
        echo ""
        show_help
        exit 1
        ;;
esac
