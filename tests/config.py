"""
测试配置文件
包含所有测试所需的配置和常量
"""

import json
import os

# ============================================
# 从根目录 config.json 读取配置（单一事实源）
# ============================================
_config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
with open(_config_path) as _f:
    _global_config = json.load(_f)

# ============================================
# 基础配置
# ============================================

# 域名配置
BASE_DOMAIN = _global_config["domain"]["baseDomain"]
ALB_DOMAIN = os.getenv("ALB_DOMAIN", "")

# AWS 配置
AWS_REGION = _global_config["project"]["region"]
AWS_ACCOUNT_ID = _global_config["project"]["accountId"]
ECS_CLUSTER = _global_config["infraStack"]["cluster"]["name"]

# ============================================
# 服务配置
# ============================================

# 支持的服务列表
SERVICES = {
    "kong-gateway": {
        "ecs_service": "kong-gateway",
        "health_endpoint": "/health",
        "port": 8000,
    },
    "functions": {
        "ecs_service": "functions-service",
        "health_endpoint": "/health",
        "path_prefix": "/functions",
        "port": 8080,
    },
    "postgrest": {
        "path_prefix": "/rest/v1",
        "test_endpoints": [
            "/",  # OpenAPI 文档
        ],
    },
}

# ============================================
# 测试项目配置
# ============================================

# 测试项目列表（用于多租户测试）
# 所有项目路由到 postgrest-test-sdk-jwt Lambda
# JWT 使用 test-sdk-jwt 的 jwt_secret 签发，ref=project-alpha
TEST_PROJECTS = [
    {
        "id": "project-alpha",
        "subdomain": f"project-alpha.{BASE_DOMAIN}",
        "anon_key": "<your-supabase-anon-key>",
        "service_role_key": "<your-supabase-service-role-key>",
    },
]

# ============================================
# Supabase 配置
# ============================================

# Supabase 匿名密钥（用于 SDK 测试）— role=anon, signed with test-sdk-jwt secret
SUPABASE_ANON_KEY = os.getenv(
    "SUPABASE_ANON_KEY",
    "<your-supabase-anon-key>"
)

# Supabase Service Role Key（用于管理操作）— role=service_role, signed with test-sdk-jwt secret
SUPABASE_SERVICE_ROLE_KEY = os.getenv(
    "SUPABASE_SERVICE_ROLE_KEY",
    "<your-supabase-service-role-key>"
)

# ============================================
# 超时和性能配置
# ============================================

# 超时配置（秒）
TIMEOUTS = {
    "connection": 5,
    "read": 30,
    "health_check": 10,
}

# 性能基准
PERFORMANCE_BENCHMARKS = {
    "health_check": 5000,  # ms
    "api_response": 2000,  # ms
}

# 重试配置
RETRY_CONFIG = {
    "max_attempts": 3,
    "backoff_factor": 2,
    "retry_statuses": [500, 502, 503, 504],
}

# ============================================
# 辅助函数
# ============================================

def get_alb_url(path: str = "") -> str:
    """获取 ALB URL"""
    return f"https://{ALB_DOMAIN}{path}"

def get_subdomain_url(project_id: str, path: str = "") -> str:
    """获取子域名 URL"""
    return f"https://{project_id}.{BASE_DOMAIN}{path}"

def get_service_url(service_name: str, use_alb: bool = True) -> str:
    """获取服务 URL"""
    service = SERVICES.get(service_name, {})
    path = service.get("path_prefix", "")
    health = service.get("health_endpoint", "")

    if use_alb:
        return get_alb_url(path + health)
    else:
        # 使用第一个测试项目的子域名
        return get_subdomain_url(TEST_PROJECTS[0]["id"], path + health)


if __name__ == "__main__":
    # 测试配置
    print("=== 测试配置验证 ===")
    print(f"Base Domain: {BASE_DOMAIN}")
    print(f"ALB Domain: {ALB_DOMAIN}")
    print(f"AWS Region: {AWS_REGION}")
    print(f"\n服务列表:")
    for service_name in SERVICES.keys():
        print(f"  - {service_name}")
    print(f"\n测试项目:")
    for project in TEST_PROJECTS:
        print(f"  - {project['id']}: {project['subdomain']}")
