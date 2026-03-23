#!/bin/bash

# Functions Service Local Test Script

echo "=========================================="
echo "🧪 Testing Functions Service Locally"
echo "=========================================="
echo ""

BASE_URL="http://localhost:8080"

# 测试 1: 健康检查
echo "Test 1: Health Check"
echo "-------------------"
curl -s $BASE_URL/health | python3 -m json.tool
echo ""
echo ""

# 测试 2: Functions 端点 (GET)
echo "Test 2: Functions Endpoint (GET)"
echo "--------------------------------"
curl -s -H "X-Project-ID: test-project" $BASE_URL/functions | python3 -m json.tool
echo ""
echo ""

# 测试 3: Functions 端点 (POST with data)
echo "Test 3: Functions Endpoint (POST with data)"
echo "-------------------------------------------"
curl -s -X POST \
  -H "X-Project-ID: project-alpha" \
  -H "Content-Type: application/json" \
  -d '{"name": "test-function", "runtime": "python3.11"}' \
  $BASE_URL/functions | python3 -m json.tool
echo ""
echo ""

# 测试 4: Functions 子路径
echo "Test 4: Functions Subpath"
echo "-------------------------"
curl -s -H "X-Project-ID: project-beta" \
  $BASE_URL/functions/hello-world | python3 -m json.tool
echo ""
echo ""

# 测试 5: 缺少 Project ID
echo "Test 5: Missing Project ID (should fail)"
echo "----------------------------------------"
curl -s $BASE_URL/functions | python3 -m json.tool
echo ""
echo ""

# 测试 6: API 文档
echo "Test 6: API Documentation"
echo "-------------------------"
curl -s $BASE_URL/ | python3 -m json.tool
echo ""
echo ""

echo "=========================================="
echo "✅ All tests completed!"
echo "=========================================="
