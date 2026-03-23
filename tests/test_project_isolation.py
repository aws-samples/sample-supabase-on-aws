#!/usr/bin/env python3
"""
验证删除项目 A 不影响项目 B 的函数调用
"""

import os
import sys
import requests
import json
import time
import subprocess
from urllib3.exceptions import InsecureRequestWarning
requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import BASE_DOMAIN, ALB_DOMAIN

STUDIO_ALB = os.getenv("STUDIO_ALB", f"https://{ALB_DOMAIN}")
SUPABASE_DOMAIN = BASE_DOMAIN

def get_admin_api_key():
    result = subprocess.run(
        ['aws', 'secretsmanager', 'get-secret-value', 
         '--secret-id', 'supabase/admin-api-key',
         '--region', 'us-east-1',
         '--query', 'SecretString',
         '--output', 'text'],
        capture_output=True, text=True, check=True
    )
    return result.stdout.strip()

ADMIN_API_KEY = get_admin_api_key()

print("=" * 70)
print("验证删除项目 A 不影响项目 B")
print("=" * 70)

# 创建项目 A
print("\n=== 1. 创建项目 A ===")
resp = requests.post(
    f"{STUDIO_ALB}/api/v1/projects",
    json={"name": f"test-project-a-{int(time.time())}"},
    verify=False, timeout=300  # nosec B501
)
assert resp.status_code == 201
project_a_ref = resp.json()['ref']
project_a_domain = f"https://{project_a_ref}.{SUPABASE_DOMAIN}"
print(f"✓ 项目 A: {project_a_ref}")

# 创建项目 B
print("\n=== 2. 创建项目 B ===")
resp = requests.post(
    f"{STUDIO_ALB}/api/v1/projects",
    json={"name": f"test-project-b-{int(time.time())}"},
    verify=False, timeout=300  # nosec B501
)
assert resp.status_code == 201
project_b_ref = resp.json()['ref']
project_b_domain = f"https://{project_b_ref}.{SUPABASE_DOMAIN}"
print(f"✓ 项目 B: {project_b_ref}")

print("\n等待项目就绪（30秒）...")
time.sleep(30)

# 获取项目 A 的 API key
print("\n=== 3. 获取项目 A 的 API Key ===")
resp = requests.get(f"{STUDIO_ALB}/api/v1/projects/{project_a_ref}/api-keys", verify=False)  # nosec B501
assert resp.status_code == 200
anon_key_a = next(k['api_key'] for k in resp.json() if k['name'] == 'anon')
print(f"✓ API Key A: {anon_key_a[:30]}...")

# 获取项目 B 的 API key
print("\n=== 4. 获取项目 B 的 API Key ===")
resp = requests.get(f"{STUDIO_ALB}/api/v1/projects/{project_b_ref}/api-keys", verify=False)  # nosec B501
assert resp.status_code == 200
anon_key_b = next(k['api_key'] for k in resp.json() if k['name'] == 'anon')
print(f"✓ API Key B: {anon_key_b[:30]}...")

# 在项目 A 部署函数
print("\n=== 5. 在项目 A 部署函数 ===")
code_a = '''Deno.serve(() => {
  return new Response("Function from Project A")
})'''
files = {'file': ('index.ts', code_a, 'text/plain')}
resp = requests.post(
    f"{STUDIO_ALB}/api/v1/projects/{project_a_ref}/functions/deploy?slug=test-func-a",
    files=files, verify=False  # nosec B501
)
assert resp.status_code == 201
print("✓ 函数 A 部署成功")

# 在项目 B 部署函数
print("\n=== 6. 在项目 B 部署函数 ===")
code_b = '''Deno.serve(() => {
  return new Response("Function from Project B")
})'''
files = {'file': ('index.ts', code_b, 'text/plain')}
resp = requests.post(
    f"{STUDIO_ALB}/api/v1/projects/{project_b_ref}/functions/deploy?slug=test-func-b",
    files=files, verify=False  # nosec B501
)
assert resp.status_code == 201
print("✓ 函数 B 部署成功")

print("\n等待函数就绪（10秒）...")
time.sleep(10)

# 验证项目 A 的函数可调用
print("\n=== 7. 验证项目 A 的函数可调用 ===")
resp = requests.get(
    f"{project_a_domain}/functions/v1/test-func-a",
    headers={"apikey": anon_key_a},
    verify=False  # nosec B501
)
assert resp.status_code == 200
assert "Project A" in resp.text
print(f"✓ 项目 A 函数调用成功: {resp.text}")

# 验证项目 B 的函数可调用
print("\n=== 8. 验证项目 B 的函数可调用 ===")
resp = requests.get(
    f"{project_b_domain}/functions/v1/test-func-b",
    headers={"apikey": anon_key_b},
    verify=False  # nosec B501
)
assert resp.status_code == 200
assert "Project B" in resp.text
print(f"✓ 项目 B 函数调用成功: {resp.text}")

# 删除项目 A
print("\n=== 9. 删除项目 A ===")
headers = {"Authorization": f"Bearer {ADMIN_API_KEY}"}
resp = requests.delete(
    f"{STUDIO_ALB}/admin/v1/projects/{project_a_ref}",
    headers=headers, verify=False  # nosec B501
)
assert resp.status_code == 204
print("✓ 项目 A 删除成功")

print("\n等待清理完成（10秒）...")
time.sleep(10)

# 验证项目 A 的函数不可调用
print("\n=== 10. 验证项目 A 的函数不可调用 ===")
resp = requests.get(
    f"{project_a_domain}/functions/v1/test-func-a",
    headers={"apikey": anon_key_a},
    verify=False  # nosec B501
)
if resp.status_code in [401, 404, 500, 503]:
    print(f"✓ 项目 A 函数不可调用（{resp.status_code}）")
else:
    print(f"⚠ 项目 A 函数仍可调用（{resp.status_code}）")

# 验证项目 B 的函数仍然可调用
print("\n=== 11. 验证项目 B 的函数仍然可调用 ===")
resp = requests.get(
    f"{project_b_domain}/functions/v1/test-func-b",
    headers={"apikey": anon_key_b},
    verify=False  # nosec B501
)
assert resp.status_code == 200, f"项目 B 函数调用失败: {resp.status_code} - {resp.text}"
assert "Project B" in resp.text
print(f"✓ 项目 B 函数仍然正常: {resp.text}")

# 验证项目 B 的函数列表正常
print("\n=== 12. 验证项目 B 的函数列表正常 ===")
resp = requests.get(f"{STUDIO_ALB}/api/v1/projects/{project_b_ref}/functions", verify=False)  # nosec B501
assert resp.status_code == 200
functions = resp.json()
assert len(functions) == 1
assert functions[0]['slug'] == 'test-func-b'
print(f"✓ 项目 B 函数列表正常: {[f['slug'] for f in functions]}")

# 清理项目 B
print("\n=== 13. 清理项目 B ===")
resp = requests.delete(
    f"{STUDIO_ALB}/admin/v1/projects/{project_b_ref}",
    headers=headers, verify=False  # nosec B501
)
assert resp.status_code == 204
print("✓ 项目 B 删除成功")

print("\n" + "=" * 70)
print("✅ 验证完成！删除项目 A 不影响项目 B 的函数调用")
print("=" * 70)
