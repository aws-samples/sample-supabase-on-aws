import os
from flask import Flask, request, jsonify

app = Flask(__name__)

# 服务配置
SERVICE_NAME = "Functions Service"
SERVICE_VERSION = "1.0.0"

@app.route('/health')
def health():
    """健康检查端点"""
    return jsonify({
        "status": "healthy",
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION
    }), 200

@app.route('/functions', methods=['GET', 'POST'])
def functions():
    """
    Functions 端点
    从 X-Project-ID header 中获取项目 ID 并返回
    """
    # 从请求头中获取 X-Project-ID
    project_id = request.headers.get('X-Project-ID')

    # 如果没有提供项目 ID
    if not project_id:
        return jsonify({
            "error": "Missing X-Project-ID header",
            "message": "Please provide X-Project-ID in request headers",
            "example": {
                "header": "X-Project-ID",
                "value": "project-alpha"
            }
        }), 400

    # 获取请求方法
    method = request.method

    # 获取查询参数（如果有）
    query_params = dict(request.args)

    # 获取请求体（如果有）
    request_data = None
    if method == 'POST':
        try:
            request_data = request.get_json()
        except:
            request_data = None

    # 构建响应
    response = {
        "service": SERVICE_NAME,
        "message": "Functions endpoint accessed successfully",
        "project_id": project_id,
        "method": method,
        "path": request.path,
        "timestamp": str(__import__('datetime').datetime.utcnow()),
    }

    # 如果有查询参数，添加到响应
    if query_params:
        response["query_params"] = query_params

    # 如果有请求体，添加到响应
    if request_data:
        response["request_data"] = request_data

    return jsonify(response), 200

@app.route('/functions/<path:subpath>', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
def functions_subpath(subpath):
    """
    Functions 子路径端点
    支持所有 HTTP 方法，返回项目 ID 和路径信息
    """
    # 从请求头中获取 X-Project-ID
    project_id = request.headers.get('X-Project-ID')

    # 如果没有提供项目 ID
    if not project_id:
        return jsonify({
            "error": "Missing X-Project-ID header",
            "message": "Please provide X-Project-ID in request headers"
        }), 400

    # 获取请求方法
    method = request.method

    # 获取查询参数（如果有）
    query_params = dict(request.args)

    # 获取请求体（如果有）
    request_data = None
    if method in ['POST', 'PUT', 'PATCH']:
        try:
            request_data = request.get_json()
        except:
            request_data = None

    # 构建响应
    response = {
        "service": SERVICE_NAME,
        "message": f"Functions subpath accessed: /{subpath}",
        "project_id": project_id,
        "method": method,
        "path": f"/functions/{subpath}",
        "subpath": subpath,
        "timestamp": str(__import__('datetime').datetime.utcnow()),
    }

    # 如果有查询参数，添加到响应
    if query_params:
        response["query_params"] = query_params

    # 如果有请求体，添加到响应
    if request_data:
        response["request_data"] = request_data

    return jsonify(response), 200

@app.route('/')
def index():
    """API 文档"""
    return jsonify({
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "description": "Edge Functions service that extracts and returns project ID from headers",
        "endpoints": {
            "health": {
                "method": "GET",
                "path": "/health",
                "description": "Health check endpoint"
            },
            "functions": {
                "method": "GET, POST",
                "path": "/functions",
                "description": "Main functions endpoint, returns project ID from X-Project-ID header",
                "required_headers": {
                    "X-Project-ID": "Your project identifier (e.g., project-alpha)"
                },
                "example": {
                    "curl": "curl -H 'X-Project-ID: project-alpha' https://api.example.com/functions"
                }
            },
            "functions_subpath": {
                "method": "GET, POST, PUT, PATCH, DELETE",
                "path": "/functions/<subpath>",
                "description": "Functions subpath endpoint, supports all HTTP methods",
                "required_headers": {
                    "X-Project-ID": "Your project identifier"
                },
                "example": {
                    "curl": "curl -H 'X-Project-ID: project-alpha' https://api.example.com/functions/my-function"
                }
            }
        },
        "usage": {
            "project_id_extraction": "Service extracts project ID from X-Project-ID header",
            "response_format": "Returns JSON with project ID and request details",
            "supported_methods": ["GET", "POST", "PUT", "PATCH", "DELETE"]
        }
    }), 200

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False)
