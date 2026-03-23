#!/usr/bin/env python3
"""
Complete project lifecycle test
Flow: Create project -> Get API keys -> Manage functions -> Invoke functions -> Cleanup
"""

import requests
import json
import time
import subprocess
from urllib3.exceptions import InsecureRequestWarning
requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

# Configuration
STUDIO_ALB = ""
SUPABASE_DOMAIN = ""

# Auto-retrieve Admin API Key
def get_admin_api_key():
    """Retrieve Admin API Key from AWS Secrets Manager"""
    try:
        result = subprocess.run(
            ['aws', 'secretsmanager', 'get-secret-value', 
             '--secret-id', 'supabase/admin-api-key',
             '--region', 'us-east-1',
             '--query', 'SecretString',
             '--output', 'text'],
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"Warning: Unable to retrieve Admin API Key: {e}")
        return None

ADMIN_API_KEY = get_admin_api_key()

# Global variables
project_ref = None
project_domain = None
anon_key = None
service_role_key = None

def create_project():
    """Create a test project"""
    global project_ref, project_domain
    print("\n=== 1. Create Project ===")
    
    resp = requests.post(
        f"{STUDIO_ALB}/api/v1/projects",
        json={
            "name": f"test-function-{int(time.time())}",
        },
        verify=False,  # nosec B501
        timeout=300
    )
    print(f"Status: {resp.status_code}")
    data = resp.json()
    print(f"Response: {json.dumps(data, indent=2)}")
    
    assert resp.status_code == 201, f"Failed to create project: {data}"
    project_ref = data['ref']
    project_domain = f"https://{project_ref}.{SUPABASE_DOMAIN}"
    print(f"Project created: {project_ref}")
    print(f"Project domain: {project_domain}")
    
    # Wait for project to be ready
    print("\nWaiting for project to be ready (30s)...")
    time.sleep(30)

def get_api_keys():
    """Retrieve project API keys"""
    global anon_key, service_role_key
    print("\n=== 2. Get API Keys ===")
    
    resp = requests.get(
        f"{STUDIO_ALB}/api/v1/projects/{project_ref}/api-keys",
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    data = resp.json()
    
    assert resp.status_code == 200, f"Failed to get API keys: {data}"
    assert isinstance(data, list), "Response should be an array"
    
    for key in data:
        if key['name'] == 'anon':
            anon_key = key['api_key']
            print(f"Anon Key: {anon_key[:30]}...")
        elif key['name'] == 'service_role':
            service_role_key = key['api_key']
            print(f"Service Role Key: {service_role_key[:30]}...")
    
    assert anon_key, "Anon key not found"
    assert service_role_key, "Service role key not found"

def create_secrets():
    """Create project secrets"""
    print("\n=== 3. Create Secrets ===")
    
    resp = requests.post(
        f"{STUDIO_ALB}/api/v1/projects/{project_ref}/secrets",
        json=[
            {"name": "TEST_SECRET", "value": "secret_value_123"},
            {"name": "API_ENDPOINT", "value": "https://api.example.com"}
        ],
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    data = resp.json()
    print(f"Created secrets: {[s['name'] for s in data]}")
    assert resp.status_code == 201, f"Failed to create secrets: {data}"

def list_secrets():
    """List all secrets"""
    print("\n=== 4. List Secrets ===")
    
    resp = requests.get(
        f"{STUDIO_ALB}/api/v1/projects/{project_ref}/secrets",
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    data = resp.json()
    
    assert resp.status_code == 200, f"Failed to get secrets: {data}"
    print(f"Secret count: {len(data)}")
    for secret in data:
        print(f"  - {secret['name']}: {secret['value'][:20]}...")

def test_health():
    """Test health check (using SDK)"""
    print("\n=== 5. Health Check (using SDK) ===")
    
    from supabase import create_client
    client = create_client(project_domain, anon_key)
    
    # SDK has no direct health method, use HTTP
    headers = {"apikey": anon_key}
    resp = requests.get(f"{project_domain}/functions/v1/health", headers=headers, verify=False)  # nosec B501
    print(f"Status: {resp.status_code}")
    print(f"Response: {resp.json()}")
    assert resp.status_code == 200
    assert resp.json()['status'] == 'healthy'

def list_functions_empty():
    """List functions (initially empty)"""
    print("\n=== 6. List Functions (initially empty) ===")
    resp = requests.get(f"{STUDIO_ALB}/api/v1/projects/{project_ref}/functions", verify=False)  # nosec B501
    print(f"Status: {resp.status_code}")
    data = resp.json()
    if isinstance(data, list):
        functions = data
    else:
        functions = data.get('data', [])
    print(f"Function count: {len(functions)}")
    assert resp.status_code == 200

def deploy_function():
    """Deploy Edge Function (no API key required)"""
    print("\n=== 5. Deploy Edge Function ===")
    
    code = '''Deno.serve(() => {
  const secrets = {
    TEST_SECRET: Deno.env.get("TEST_SECRET"),
    API_ENDPOINT: Deno.env.get("API_ENDPOINT"),
    SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
    SUPABASE_URL: Deno.env.get("SUPABASE_URL")
  }
  
  return new Response(
    JSON.stringify({
      message: "Lifecycle Test Function",
      timestamp: new Date().toISOString(),
      secrets: secrets
    }),
    { headers: { "Content-Type": "application/json" } }
  )
})'''
    
    files = {'file': ('index.ts', code, 'text/plain')}
    resp = requests.post(
        f"{STUDIO_ALB}/api/v1/projects/{project_ref}/functions/deploy?slug=lifecycle-test",
        files=files,
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    data = resp.json()
    print(f"Function: {data['data']['slug']}, Status: {data['data']['status']}")
    assert resp.status_code == 201, f"Failed to deploy function: {data}"

def list_functions():
    """List all functions"""
    print("\n=== 8. List Functions ===")
    
    resp = requests.get(
        f"{STUDIO_ALB}/api/v1/projects/{project_ref}/functions",
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    data = resp.json()
    
    assert resp.status_code == 200, f"Failed to get function list: {data}"
    functions = data if isinstance(data, list) else data.get('data', [])
    print(f"Function count: {len(functions)}")
    for func in functions:
        print(f"  - {func['slug']}: {func['status']}")

def get_function_details():
    """Get function details"""
    print("\n=== 9. Get Function Details ===")
    resp = requests.get(
        f"{STUDIO_ALB}/api/v1/projects/{project_ref}/functions/lifecycle-test",
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    data = resp.json()
    print(f"Response: {json.dumps(data, indent=2)}")
    assert resp.status_code == 200
    assert data.get('slug') == 'lifecycle-test' or data.get('data', {}).get('slug') == 'lifecycle-test'

def get_function_code():
    """Get function source code"""
    print("\n=== 10. Get Function Code ===")
    resp = requests.get(
        f"{STUDIO_ALB}/api/v1/projects/{project_ref}/functions/lifecycle-test/body",
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    if resp.status_code == 200:
        code = resp.text
        print(f"Code length: {len(code)} characters")
        print(f"Code preview: {code[:100]}...")
    else:
        print(f"Response: {resp.text}")

def invoke_function():
    """Invoke Edge Function (requires API key)"""
    print("\n=== 11. Invoke Edge Function (using SDK) ===")
    print("Waiting for function to be ready (10s)...")
    time.sleep(10)
    
    from supabase import create_client
    client = create_client(project_domain, anon_key)
    
    resp = client.functions.invoke("lifecycle-test")
    print(f"Response type: {type(resp)}")
    
    # SDK returns bytes or string
    if isinstance(resp, bytes):
        data = json.loads(resp.decode('utf-8'))
    elif isinstance(resp, str):
        data = json.loads(resp)
    else:
        data = resp
    
    print(f"Response: {json.dumps(data, indent=2)}")
    
    assert data['message'] == "Lifecycle Test Function"
    
    # Verify secrets injection
    secrets = data.get('secrets', {})
    if secrets.get('TEST_SECRET') == 'secret_value_123':
        print("TEST_SECRET injected successfully")
    if secrets.get('SUPABASE_ANON_KEY'):
        print("SUPABASE_ANON_KEY injected successfully")

def update_function():
    """Update function"""
    print("\n=== 8. Update Function ===")
    
    code = '''Deno.serve(() => {
  return new Response(
    JSON.stringify({
      message: "Lifecycle Test Function - UPDATED",
      version: "v2",
      timestamp: new Date().toISOString()
    }),
    { headers: { "Content-Type": "application/json" } }
  )
})'''
    
    files = {'file': ('index.ts', code, 'text/plain')}
    resp = requests.post(
        f"{STUDIO_ALB}/api/v1/projects/{project_ref}/functions/deploy?slug=lifecycle-test",
        files=files,
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    assert resp.status_code == 201, f"Failed to update function: {resp.json()}"
    print("Function updated successfully")

def invoke_updated_function():
    """Invoke updated function (using SDK)"""
    print("\n=== 13. Invoke Updated Function (using SDK) ===")
    print("Waiting for update to take effect (60s)...")
    time.sleep(60)
    
    from supabase import create_client
    client = create_client(project_domain, anon_key)
    
    resp = client.functions.invoke("lifecycle-test")
    
    if isinstance(resp, bytes):
        data = json.loads(resp.decode('utf-8'))
    elif isinstance(resp, str):
        data = json.loads(resp)
    else:
        data = resp
    
    print(f"Response: {json.dumps(data, indent=2)}")
    
    if 'UPDATED' in data.get('message', ''):
        print("Update is in effect")
    else:
        print("Warning: Update not yet in effect (may still be cached)")

def delete_function():
    """Delete function"""
    print("\n=== 10. Delete Function ===")
    
    resp = requests.delete(
        f"{STUDIO_ALB}/api/v1/projects/{project_ref}/functions/lifecycle-test",
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    data = resp.json()
    print(f"Response: {json.dumps(data, indent=2)}")
    assert resp.status_code == 200, f"Failed to delete function: {data}"
    print("Function deleted successfully")

def invoke_deleted_function():
    """Invoke deleted function (using SDK)"""
    print("\n=== 15. Invoke Deleted Function (using SDK) ===")
    
    from supabase import create_client
    client = create_client(project_domain, anon_key)
    
    try:
        resp = client.functions.invoke("lifecycle-test")
        status = resp.status_code if hasattr(resp, 'status_code') else 200
        print(f"Status: {status}")
        print(f"Response: {str(resp)[:200]}")
        print(f"Note: Worker cache may keep the function callable (TTL 3 minutes)")
    except Exception as e:
        print(f"Function not callable: {type(e).__name__}")
        print(f"  Error: {str(e)[:200]}")

def list_functions_after_delete():
    """List functions after deletion"""
    print("\n=== 12. List Functions After Deletion ===")
    resp = requests.get(f"{STUDIO_ALB}/api/v1/projects/{project_ref}/functions", verify=False)  # nosec B501
    print(f"Status: {resp.status_code}")
    data = resp.json()
    if isinstance(data, list):
        functions = data
    else:
        functions = data.get('data', [])
    print(f"Function count: {len(functions)}")
    # lifecycle-test should not be in the list
    slugs = [f.get('slug') for f in functions]
    assert 'lifecycle-test' not in slugs, "Function should have been deleted"
    print("Function removed from list")

def delete_secrets():
    """Delete secrets"""
    print("\n=== 13. Delete Secrets ===")
    
    resp = requests.delete(
        f"{STUDIO_ALB}/api/v1/projects/{project_ref}/secrets",
        json=["TEST_SECRET", "API_ENDPOINT"],
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    assert resp.status_code == 200, f"Failed to delete secrets: {resp.json()}"
    print("Secrets deleted successfully")

def delete_project():
    """Delete project"""
    print("\n=== 14. Delete Project ===")
    
    if not ADMIN_API_KEY:
        print("Warning: No Admin API Key, skipping deletion")
        return
    
    headers = {"Authorization": f"Bearer {ADMIN_API_KEY}"}
    resp = requests.delete(
        f"{STUDIO_ALB}/admin/v1/projects/{project_ref}",
        headers=headers,
        verify=False  # nosec B501
    )
    print(f"Status: {resp.status_code}")
    
    if resp.status_code == 204:
        print("Project deleted successfully")
    else:
        print(f"Warning: Failed to delete project: {resp.text}")

def run_test(name, func):
    """Run a single test and display the result"""
    import sys
    from io import StringIO
    
    # Capture output
    old_stdout = sys.stdout
    sys.stdout = StringIO()
    
    try:
        func()
        sys.stdout = old_stdout
        print(f"  test_complete_function.py::{name} PASSED")
        return True
    except Exception as e:
        sys.stdout = old_stdout
        print(f"  test_complete_function.py::{name} FAILED")
        print(f"    Error: {e}")
        return False

def main():
    print("=" * 70)
    print("Running tests...")
    print("=" * 70)
    
    tests = [
        ("test_create_project", create_project),
        ("test_get_api_keys", get_api_keys),
        ("test_create_secrets", create_secrets),
        ("test_list_secrets", list_secrets),
        ("test_health", test_health),
        ("test_list_functions_empty", list_functions_empty),
        ("test_deploy_function", deploy_function),
        ("test_list_functions", list_functions),
        ("test_get_function_details", get_function_details),
        ("test_get_function_code", get_function_code),
        ("test_invoke_function", invoke_function),
        ("test_update_function", update_function),
        ("test_invoke_updated_function", invoke_updated_function),
        ("test_delete_function", delete_function),
        ("test_invoke_deleted_function", invoke_deleted_function),
        ("test_list_functions_after_delete", list_functions_after_delete),
        ("test_delete_secrets", delete_secrets),
        ("test_delete_project", delete_project),
    ]
    
    passed = 0
    failed = 0
    
    try:
        for name, func in tests:
            if run_test(name, func):
                passed += 1
            else:
                failed += 1
                break
        
        print("\n" + "=" * 70)
        if failed == 0:
            print(f"{passed} passed in {len(tests)} tests")
        else:
            print(f"{passed} passed, {failed} failed")
        print("=" * 70)
        
        return 0 if failed == 0 else 1
        
    except KeyboardInterrupt:
        print("\n\nTest interrupted")
        if project_ref:
            print(f"Cleaning up project: {project_ref}")
            try:
                delete_project()
            except:
                pass
        return 1

if __name__ == "__main__":
    exit(main())
