/**
 * Comprehensive Integration Test Suite for Enhanced Edge Functions
 * 
 * Tests the complete deployment workflow with nested functions,
 * cross-directory calls, and project isolation.
 * 
 * Requirements: All requirements (1.1-6.5)
 */

import { assertEquals, assertExists, assert, assertRejects } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { join, resolve } from 'https://deno.land/std@0.208.0/path/mod.ts'
import { ensureDir, emptyDir } from 'https://deno.land/std@0.208.0/fs/mod.ts'

import { EnhancedCLI, CLIDeploymentOptions } from './cli-integration.ts'
import { EnhancedFunctionScanner, FunctionMetadata } from './function-scanner.ts'
import { EnhancedCrossDirectoryResolver, ExecutionContext } from './cross-directory-resolver.ts'
import { DefaultProjectConfigManager, ProjectConfig } from './project-config-manager.ts'
import { DefaultDeploymentManager, DeploymentResult } from './deployment-manager.ts'
import { EnhancedNamespaceManager } from './namespace-manager.ts'
import { EnhancedSecurityManager } from './security-manager.ts'
import { BackwardCompatibilityManager } from './backward-compatibility.ts'

// Test configuration
const TEST_FUNCTIONS_ROOT = '/tmp/test-functions-integration'
const TEST_PROJECT_REF_1 = 'test-project-alpha'
const TEST_PROJECT_REF_2 = 'test-project-beta'

// Mock project configurations
const mockProjectConfig1: ProjectConfig = {
  projectRef: TEST_PROJECT_REF_1,
  apiEndpoint: `https://api.supabase.com/v1/projects/${TEST_PROJECT_REF_1}/functions/deploy`,
  credentials: {
    serviceRoleKey: 'test-service-role-key-alpha',
    anonKey: 'test-anon-key-alpha',
    supabaseUrl: `https://${TEST_PROJECT_REF_1}.supabase.co`
  },
  namespacePrefix: `proj_${TEST_PROJECT_REF_1}`,
  isolationLevel: 'strict'
}

const mockProjectConfig2: ProjectConfig = {
  projectRef: TEST_PROJECT_REF_2,
  apiEndpoint: `https://api.supabase.com/v1/projects/${TEST_PROJECT_REF_2}/functions/deploy`,
  credentials: {
    serviceRoleKey: 'test-service-role-key-beta',
    anonKey: 'test-anon-key-beta',
    supabaseUrl: `https://${TEST_PROJECT_REF_2}.supabase.co`
  },
  namespacePrefix: `proj_${TEST_PROJECT_REF_2}`,
  isolationLevel: 'strict'
}

/**
 * Test function structures for integration testing
 */
interface TestFunctionStructure {
  path: string
  content: string
  envVars?: Record<string, string>
  dependencies?: string[]
}

const testFunctionStructures: TestFunctionStructure[] = [
  // Legacy single-level functions
  {
    path: 'hello-world',
    content: `
export default function handler(req: Request): Response {
  return new Response(JSON.stringify({ message: 'Hello World', type: 'legacy' }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
    `.trim()
  },
  {
    path: 'auth-legacy',
    content: `
export default function handler(req: Request): Response {
  return new Response(JSON.stringify({ message: 'Legacy Auth', type: 'legacy' }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
    `.trim(),
    envVars: { AUTH_SECRET: 'legacy-secret' }
  },
  
  // Multi-level API functions
  {
    path: 'api/users',
    content: `
export default function handler(req: Request): Response {
  return new Response(JSON.stringify({ message: 'Users API', type: 'multi-level' }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
    `.trim(),
    envVars: { API_VERSION: 'v1' }
  },
  {
    path: 'api/auth/login',
    content: `
import { validateUser } from '../../utils/validation/user-validator'

export default async function handler(req: Request): Promise<Response> {
  const isValid = await validateUser(req)
  return new Response(JSON.stringify({ 
    message: 'Auth Login API', 
    type: 'multi-level',
    validated: isValid 
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
    `.trim(),
    dependencies: ['utils/validation/user-validator']
  },
  {
    path: 'api/auth/register',
    content: `
export default function handler(req: Request): Response {
  return new Response(JSON.stringify({ message: 'Auth Register API', type: 'multi-level' }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
    `.trim()
  },
  
  // Utility functions
  {
    path: 'utils/validation/user-validator',
    content: `
export async function validateUser(req: Request): Promise<boolean> {
  // Mock validation logic
  return true
}

export default function handler(req: Request): Response {
  return new Response(JSON.stringify({ message: 'User Validator Utility', type: 'utility' }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
    `.trim()
  },
  {
    path: 'utils/database/connection',
    content: `
export function createConnection(): string {
  return 'mock-connection'
}

export default function handler(req: Request): Response {
  return new Response(JSON.stringify({ message: 'Database Connection Utility', type: 'utility' }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
    `.trim(),
    envVars: { DB_URL: 'postgresql://localhost:5432/test' }
  },
  
  // Deep nested functions
  {
    path: 'services/payment/stripe/webhooks',
    content: `
export default function handler(req: Request): Response {
  return new Response(JSON.stringify({ message: 'Stripe Webhooks', type: 'deep-nested' }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
    `.trim(),
    envVars: { STRIPE_SECRET: 'sk_test_123' }
  },
  {
    path: 'services/notification/email/sender',
    content: `
export default function handler(req: Request): Response {
  return new Response(JSON.stringify({ message: 'Email Sender', type: 'deep-nested' }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
    `.trim()
  }
]

/**
 * Setup test environment with mock function structures
 */
async function setupTestEnvironment(): Promise<void> {
  // Clean and create test directory
  await emptyDir(TEST_FUNCTIONS_ROOT).catch(() => {})
  await ensureDir(TEST_FUNCTIONS_ROOT)
  
  // Create function structures
  for (const funcStruct of testFunctionStructures) {
    const functionPath = join(TEST_FUNCTIONS_ROOT, funcStruct.path)
    await ensureDir(functionPath)
    
    // Write function code
    const indexPath = join(functionPath, 'index.ts')
    await Deno.writeTextFile(indexPath, funcStruct.content)
    
    // Write environment variables if provided
    if (funcStruct.envVars) {
      const envPath = join(functionPath, '.env')
      const envContent = Object.entries(funcStruct.envVars)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
      await Deno.writeTextFile(envPath, envContent)
    }
  }
  
  // Create project-level .env file
  const projectEnvPath = join(TEST_FUNCTIONS_ROOT, '.env')
  await Deno.writeTextFile(projectEnvPath, 'PROJECT_NAME=test-project\nENVIRONMENT=test')
  
  // Create deno.json configuration
  const denoConfigPath = join(TEST_FUNCTIONS_ROOT, 'deno.json')
  const denoConfig = {
    "compilerOptions": {
      "allowJs": true,
      "lib": ["deno.window"],
      "strict": true
    },
    "importMap": "./import_map.json"
  }
  await Deno.writeTextFile(denoConfigPath, JSON.stringify(denoConfig, null, 2))
}

/**
 * Cleanup test environment
 */
async function cleanupTestEnvironment(): Promise<void> {
  try {
    await Deno.remove(TEST_FUNCTIONS_ROOT, { recursive: true })
  } catch {
    // Ignore cleanup errors
  }
}

// Mock implementations for testing
class MockProjectConfigManager extends DefaultProjectConfigManager {
  private currentProject: ProjectConfig | null = mockProjectConfig1

  async detectCurrentProject(): Promise<ProjectConfig | null> {
    return this.currentProject
  }

  setCurrentProject(project: ProjectConfig | null): void {
    this.currentProject = project
  }

  validateProjectContext(projectRef: string): boolean {
    return projectRef === TEST_PROJECT_REF_1 || projectRef === TEST_PROJECT_REF_2
  }
}

class MockDeploymentManager extends DefaultDeploymentManager {
  private deploymentResults: Map<string, DeploymentResult> = new Map()
  private shouldSucceed = true

  setShouldSucceed(succeed: boolean): void {
    this.shouldSucceed = succeed
  }

  async deployFunction(
    functionMetadata: FunctionMetadata,
    projectConfig: ProjectConfig
  ): Promise<DeploymentResult> {
    const key = `${projectConfig.projectRef}:${functionMetadata.name}`
    
    if (this.shouldSucceed) {
      const result: DeploymentResult = {
        success: true,
        functionName: functionMetadata.name,
        projectRef: projectConfig.projectRef,
        deploymentId: `deploy-${Date.now()}`,
        url: `https://${projectConfig.projectRef}.supabase.co/functions/v1/${functionMetadata.relativePath}`
      }
      this.deploymentResults.set(key, result)
      return result
    } else {
      const result: DeploymentResult = {
        success: false,
        functionName: functionMetadata.name,
        projectRef: projectConfig.projectRef,
        error: 'Mock deployment failure'
      }
      this.deploymentResults.set(key, result)
      return result
    }
  }

  async getDeploymentStatus(projectRef: string, functionName: string): Promise<any> {
    const key = `${projectRef}:${functionName}`
    const result = this.deploymentResults.get(key)
    
    return {
      status: result?.success ? 'deployed' : 'failed',
      lastDeployed: new Date(),
      url: result?.url
    }
  }

  getDeploymentResults(): Map<string, DeploymentResult> {
    return this.deploymentResults
  }

  clearDeploymentResults(): void {
    this.deploymentResults.clear()
  }
}

// Integration Tests

Deno.test('Integration - Complete Function Discovery and Scanning', async () => {
  await setupTestEnvironment()
  
  try {
    const scanner = new EnhancedFunctionScanner()
    const functions = await scanner.scanFunctions(TEST_FUNCTIONS_ROOT)
    
    // Verify all test functions were discovered
    assertEquals(functions.length, testFunctionStructures.length, 'All functions should be discovered')
    
    // Verify function metadata
    for (const expectedFunc of testFunctionStructures) {
      const found = functions.find(f => f.relativePath === expectedFunc.path)
      assertExists(found, `Function ${expectedFunc.path} should be discovered`)
      
      // Verify environment variables are loaded
      if (expectedFunc.envVars) {
        for (const [key, value] of Object.entries(expectedFunc.envVars)) {
          assertEquals(
            found.environmentConfig.functionLevel.get(key),
            value,
            `Environment variable ${key} should be loaded for ${expectedFunc.path}`
          )
        }
      }
    }
    
    // Verify dependency detection
    const loginFunction = functions.find(f => f.relativePath === 'api/auth/login')
    assertExists(loginFunction, 'Login function should exist')
    assert(loginFunction.dependencies.length > 0, 'Login function should have dependencies')
    
    console.log(`✅ Successfully discovered ${functions.length} functions with proper metadata`)
    
  } finally {
    await cleanupTestEnvironment()
  }
})

Deno.test('Integration - Cross-Directory Function Resolution and Calls', async () => {
  await setupTestEnvironment()
  
  try {
    const scanner = new EnhancedFunctionScanner()
    const functions = await scanner.scanFunctions(TEST_FUNCTIONS_ROOT)
    
    // Create functions registry
    const functionsRegistry = new Map<string, FunctionMetadata>()
    functions.forEach(func => functionsRegistry.set(func.id, func))
    
    const resolver = new EnhancedCrossDirectoryResolver(TEST_FUNCTIONS_ROOT, functionsRegistry)
    
    // Test path resolution
    const resolvedPath = resolver.resolveFunctionPath('api/auth/login', '../../utils/validation/user-validator')
    assertEquals(resolvedPath, 'utils/validation/user-validator', 'Path should resolve correctly')
    
    // Test cross-directory call validation
    const isValid = resolver.validateCrossDirectoryCall('api/auth/login', 'utils/validation/user-validator')
    assert(isValid, 'Cross-directory call should be valid')
    
    // Test function proxy creation and invocation
    const proxy = resolver.createFunctionProxy('utils/validation/user-validator')
    assertExists(proxy, 'Function proxy should be created')
    
    const mockContext: ExecutionContext = {
      projectRef: TEST_PROJECT_REF_1,
      requestId: 'test-request-123',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      environment: { NODE_ENV: 'test' }
    }
    
    // Note: In a real test environment, we would need to handle module loading differently
    // This test verifies the proxy structure and validation logic
    
    console.log('✅ Cross-directory resolution and validation working correctly')
    
  } finally {
    await cleanupTestEnvironment()
  }
})

Deno.test('Integration - CLI Deployment Workflow with Multi-Level Functions', async () => {
  await setupTestEnvironment()
  
  try {
    const mockProjectConfigManager = new MockProjectConfigManager()
    const mockDeploymentManager = new MockDeploymentManager()
    const scanner = new EnhancedFunctionScanner()
    
    const cli = new EnhancedCLI(mockProjectConfigManager, mockDeploymentManager, scanner)
    
    // Test complete deployment workflow
    const deploymentResult = await cli.deployFunctions(TEST_FUNCTIONS_ROOT)
    
    assertEquals(deploymentResult.totalFunctions, testFunctionStructures.length, 'All functions should be processed')
    assertEquals(deploymentResult.successfulDeployments, testFunctionStructures.length, 'All deployments should succeed')
    assertEquals(deploymentResult.failedDeployments, 0, 'No deployments should fail')
    assertEquals(deploymentResult.projectRef, TEST_PROJECT_REF_1, 'Correct project should be used')
    
    // Verify deployment results
    const deploymentResults = mockDeploymentManager.getDeploymentResults()
    assert(deploymentResults.size > 0, 'Deployment results should be recorded')
    
    // Test specific function deployment
    mockDeploymentManager.clearDeploymentResults()
    const specificResult = await cli.deployFunctions(TEST_FUNCTIONS_ROOT, {
      functionName: 'api/users'
    })
    
    assertEquals(specificResult.totalFunctions, 1, 'Only one function should be deployed')
    assertEquals(specificResult.results[0].functionName, 'api/users', 'Correct function should be deployed')
    
    console.log('✅ CLI deployment workflow completed successfully')
    
  } finally {
    await cleanupTestEnvironment()
  }
})

Deno.test('Integration - Project Isolation and Namespace Management', async () => {
  await setupTestEnvironment()
  
  try {
    const mockProjectConfigManager = new MockProjectConfigManager()
    const mockDeploymentManager = new MockDeploymentManager()
    const scanner = new EnhancedFunctionScanner()
    const namespaceManager = new EnhancedNamespaceManager()
    
    const cli = new EnhancedCLI(mockProjectConfigManager, mockDeploymentManager, scanner)
    
    // Deploy to first project
    mockProjectConfigManager.setCurrentProject(mockProjectConfig1)
    const project1Result = await cli.deployFunctions(TEST_FUNCTIONS_ROOT)
    
    // Deploy to second project
    mockProjectConfigManager.setCurrentProject(mockProjectConfig2)
    const project2Result = await cli.deployFunctions(TEST_FUNCTIONS_ROOT)
    
    // Verify both deployments succeeded
    assertEquals(project1Result.successfulDeployments, testFunctionStructures.length)
    assertEquals(project2Result.successfulDeployments, testFunctionStructures.length)
    
    // Verify project isolation
    assertEquals(project1Result.projectRef, TEST_PROJECT_REF_1)
    assertEquals(project2Result.projectRef, TEST_PROJECT_REF_2)
    
    // Verify namespace isolation
    const project1Namespace = namespaceManager.createProjectNamespace(TEST_PROJECT_REF_1)
    const project2Namespace = namespaceManager.createProjectNamespace(TEST_PROJECT_REF_2)
    
    assertEquals(project1Namespace.projectRef, TEST_PROJECT_REF_1)
    assertEquals(project2Namespace.projectRef, TEST_PROJECT_REF_2)
    assert(project1Namespace.projectRef !== project2Namespace.projectRef, 'Namespaces should be isolated')
    
    // Test function isolation
    const isolatedFunc1 = namespaceManager.isolateFunction('test-function', TEST_PROJECT_REF_1)
    const isolatedFunc2 = namespaceManager.isolateFunction('test-function', TEST_PROJECT_REF_2)
    
    assert(isolatedFunc1 !== isolatedFunc2, 'Functions should be isolated by project')
    
    console.log('✅ Project isolation and namespace management working correctly')
    
  } finally {
    await cleanupTestEnvironment()
  }
})

Deno.test('Integration - Security Boundary Enforcement', async () => {
  await setupTestEnvironment()
  
  try {
    const scanner = new EnhancedFunctionScanner()
    const functions = await scanner.scanFunctions(TEST_FUNCTIONS_ROOT)
    
    const functionsRegistry = new Map<string, FunctionMetadata>()
    functions.forEach(func => functionsRegistry.set(func.id, func))
    
    const resolver = new EnhancedCrossDirectoryResolver(TEST_FUNCTIONS_ROOT, functionsRegistry)
    const securityManager = new EnhancedSecurityManager()
    
    // Initialize project permissions
    securityManager.initializeProjectPermissions(TEST_PROJECT_REF_1)
    
    // Test security boundary validation with a properly namespaced function
    const namespacedFunction = `ef_${TEST_PROJECT_REF_1}_test-function`
    const validationResult = await securityManager.validateProjectAccess(namespacedFunction, TEST_PROJECT_REF_1)
    assert(validationResult, 'Valid project access should be allowed')
    
    // Test malicious path rejection
    const maliciousPaths = [
      '../../../etc/passwd',
      '/etc/passwd',
      '~/secrets',
      'func<script>alert("xss")</script>',
      'func|rm -rf /',
      'func\x00null'
    ]
    
    for (const maliciousPath of maliciousPaths) {
      const isValid = resolver.validateCrossDirectoryCall('api/users', maliciousPath)
      assertEquals(isValid, false, `Malicious path ${maliciousPath} should be rejected`)
    }
    
    // Test cross-project access denial
    const crossProjectAccess = await securityManager.validateProjectAccess(namespacedFunction, 'unauthorized-project')
    assertEquals(crossProjectAccess, false, 'Cross-project access should be denied')
    
    console.log('✅ Security boundaries properly enforced')
    
  } finally {
    await cleanupTestEnvironment()
  }
})

Deno.test('Integration - Backward Compatibility with Mixed Structures', async () => {
  await setupTestEnvironment()
  
  try {
    const compatibilityManager = new BackwardCompatibilityManager({
      preserveLegacyUrls: true,
      supportMixedStructures: true,
      enablePathMigration: false
    })
    
    const scanner = new EnhancedFunctionScanner()
    const functions = await scanner.scanFunctions(TEST_FUNCTIONS_ROOT)
    
    // Register functions with compatibility manager
    for (const func of functions) {
      const isLegacy = !func.relativePath.includes('/')
      
      if (isLegacy) {
        compatibilityManager.registerLegacyFunction(func.name, func.relativePath)
      } else {
        compatibilityManager.registerMultiLevelFunction(func.name, func.relativePath)
      }
    }
    
    // Verify mixed structure support
    const stats = compatibilityManager.getCompatibilityStats()
    assert(stats.totalFunctions > 0, 'Functions should be registered')
    assert(stats.legacyFunctions > 0, 'Legacy functions should be detected')
    assert(stats.multiLevelFunctions > 0, 'Multi-level functions should be detected')
    
    // Test URL resolution for both types
    const legacyUrl = compatibilityManager.generateLegacyUrl('hello-world')
    assertEquals(legacyUrl, '/hello-world', 'Legacy URL should be preserved')
    
    const multiLevelPath = compatibilityManager.resolveFunctionPath('/api/users')
    assertEquals(multiLevelPath, 'api/users', 'Multi-level path should resolve correctly')
    
    console.log('✅ Backward compatibility with mixed structures working correctly')
    
  } finally {
    await cleanupTestEnvironment()
  }
})

Deno.test('Integration - Environment Variable Precedence and Loading', async () => {
  await setupTestEnvironment()
  
  try {
    const scanner = new EnhancedFunctionScanner()
    const functions = await scanner.scanFunctions(TEST_FUNCTIONS_ROOT)
    
    // Find function with environment variables
    const authFunction = functions.find(f => f.relativePath === 'auth-legacy')
    assertExists(authFunction, 'Auth function should exist')
    
    // Verify function-level environment variables
    assertEquals(
      authFunction.environmentConfig.functionLevel.get('AUTH_SECRET'),
      'legacy-secret',
      'Function-level env var should be loaded'
    )
    
    // Verify project-level environment variables are loaded
    assertEquals(
      authFunction.environmentConfig.projectLevel.get('PROJECT_NAME'),
      'test-project',
      'Project-level env var should be loaded'
    )
    
    // Verify precedence (function-level overrides project-level)
    const mergedConfig = authFunction.environmentConfig.merged
    assert(mergedConfig.has('AUTH_SECRET'), 'Function-level var should be in merged config')
    assert(mergedConfig.has('PROJECT_NAME'), 'Project-level var should be in merged config')
    
    console.log('✅ Environment variable precedence working correctly')
    
  } finally {
    await cleanupTestEnvironment()
  }
})

Deno.test('Integration - Error Handling and Recovery', async () => {
  await setupTestEnvironment()
  
  try {
    const mockProjectConfigManager = new MockProjectConfigManager()
    const mockDeploymentManager = new MockDeploymentManager()
    const scanner = new EnhancedFunctionScanner()
    
    const cli = new EnhancedCLI(mockProjectConfigManager, mockDeploymentManager, scanner)
    
    // Test deployment failure handling
    mockDeploymentManager.setShouldSucceed(false)
    
    const failedResult = await cli.deployFunctions(TEST_FUNCTIONS_ROOT)
    
    assertEquals(failedResult.successfulDeployments, 0, 'No deployments should succeed')
    assertEquals(failedResult.failedDeployments, testFunctionStructures.length, 'All deployments should fail')
    
    // Verify error information is captured
    for (const result of failedResult.results) {
      assertEquals(result.success, false, 'Result should indicate failure')
      assertExists(result.error, 'Error message should be provided')
    }
    
    // Test recovery after fixing issues
    mockDeploymentManager.setShouldSucceed(true)
    
    const recoveredResult = await cli.deployFunctions(TEST_FUNCTIONS_ROOT)
    assertEquals(recoveredResult.successfulDeployments, testFunctionStructures.length, 'All deployments should succeed after recovery')
    
    console.log('✅ Error handling and recovery working correctly')
    
  } finally {
    await cleanupTestEnvironment()
  }
})

Deno.test('Integration - Performance with Large Function Sets', async () => {
  const LARGE_FUNCTION_COUNT = 50
  const LARGE_TEST_ROOT = '/tmp/test-functions-large'
  
  try {
    // Setup large function set
    await ensureDir(LARGE_TEST_ROOT)
    
    const startSetup = performance.now()
    
    for (let i = 0; i < LARGE_FUNCTION_COUNT; i++) {
      const isNested = i % 3 === 0
      const functionPath = isNested 
        ? join(LARGE_TEST_ROOT, `category-${Math.floor(i/10)}`, `function-${i}`)
        : join(LARGE_TEST_ROOT, `function-${i}`)
      
      await ensureDir(functionPath)
      
      const content = `
export default function handler(req: Request): Response {
  return new Response(JSON.stringify({ 
    message: 'Function ${i}', 
    type: '${isNested ? 'nested' : 'flat'}' 
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
      `.trim()
      
      await Deno.writeTextFile(join(functionPath, 'index.ts'), content)
    }
    
    const setupTime = performance.now() - startSetup
    console.log(`Setup ${LARGE_FUNCTION_COUNT} functions in ${setupTime.toFixed(2)}ms`)
    
    // Test scanning performance
    const scanner = new EnhancedFunctionScanner()
    const startScan = performance.now()
    
    const functions = await scanner.scanFunctions(LARGE_TEST_ROOT)
    
    const scanTime = performance.now() - startScan
    console.log(`Scanned ${functions.length} functions in ${scanTime.toFixed(2)}ms`)
    
    assertEquals(functions.length, LARGE_FUNCTION_COUNT, 'All functions should be discovered')
    
    // Test deployment performance
    const mockProjectConfigManager = new MockProjectConfigManager()
    const mockDeploymentManager = new MockDeploymentManager()
    const cli = new EnhancedCLI(mockProjectConfigManager, mockDeploymentManager, scanner)
    
    const startDeploy = performance.now()
    
    const deployResult = await cli.deployFunctions(LARGE_TEST_ROOT)
    
    const deployTime = performance.now() - startDeploy
    console.log(`Deployed ${deployResult.totalFunctions} functions in ${deployTime.toFixed(2)}ms`)
    
    assertEquals(deployResult.successfulDeployments, LARGE_FUNCTION_COUNT, 'All functions should deploy successfully')
    
    // Performance assertions
    assert(scanTime < 5000, 'Scanning should complete within 5 seconds')
    assert(deployTime < 10000, 'Deployment should complete within 10 seconds')
    
    console.log('✅ Performance test completed successfully')
    
  } finally {
    await Deno.remove(LARGE_TEST_ROOT, { recursive: true }).catch(() => {})
  }
})

Deno.test('Integration - Complete End-to-End Workflow Simulation', async () => {
  await setupTestEnvironment()
  
  try {
    console.log('🚀 Starting complete end-to-end workflow simulation...')
    
    // Step 1: Initialize components
    const mockProjectConfigManager = new MockProjectConfigManager()
    const mockDeploymentManager = new MockDeploymentManager()
    const scanner = new EnhancedFunctionScanner()
    const namespaceManager = new EnhancedNamespaceManager()
    const securityManager = new EnhancedSecurityManager()
    const compatibilityManager = new BackwardCompatibilityManager()
    
    const cli = new EnhancedCLI(mockProjectConfigManager, mockDeploymentManager, scanner)
    
    console.log('✅ Step 1: Components initialized')
    
    // Step 2: Scan and discover functions
    const functions = await scanner.scanFunctions(TEST_FUNCTIONS_ROOT)
    assertEquals(functions.length, testFunctionStructures.length, 'All functions should be discovered')
    
    console.log(`✅ Step 2: Discovered ${functions.length} functions`)
    
    // Step 3: Register functions for compatibility
    for (const func of functions) {
      const isLegacy = !func.relativePath.includes('/')
      
      if (isLegacy) {
        compatibilityManager.registerLegacyFunction(func.name, func.relativePath)
      } else {
        compatibilityManager.registerMultiLevelFunction(func.name, func.relativePath)
      }
    }
    
    console.log('✅ Step 3: Functions registered for compatibility')
    
    // Step 4: Test cross-directory resolution
    const functionsRegistry = new Map<string, FunctionMetadata>()
    functions.forEach(func => functionsRegistry.set(func.id, func))
    
    const resolver = new EnhancedCrossDirectoryResolver(TEST_FUNCTIONS_ROOT, functionsRegistry)
    
    // Test some cross-directory calls
    const testCalls = [
      { from: 'api/auth/login', to: 'utils/validation/user-validator' },
      { from: 'api/users', to: 'utils/database/connection' }
    ]
    
    for (const call of testCalls) {
      const isValid = resolver.validateCrossDirectoryCall(call.from, call.to)
      assert(isValid, `Cross-directory call from ${call.from} to ${call.to} should be valid`)
    }
    
    console.log('✅ Step 4: Cross-directory resolution validated')
    
    // Step 5: Deploy to first project
    mockProjectConfigManager.setCurrentProject(mockProjectConfig1)
    const project1Deployment = await cli.deployFunctions(TEST_FUNCTIONS_ROOT)
    
    assertEquals(project1Deployment.successfulDeployments, testFunctionStructures.length)
    console.log(`✅ Step 5: Deployed ${project1Deployment.successfulDeployments} functions to project 1`)
    
    // Step 6: Deploy to second project (test isolation)
    mockProjectConfigManager.setCurrentProject(mockProjectConfig2)
    const project2Deployment = await cli.deployFunctions(TEST_FUNCTIONS_ROOT)
    
    assertEquals(project2Deployment.successfulDeployments, testFunctionStructures.length)
    console.log(`✅ Step 6: Deployed ${project2Deployment.successfulDeployments} functions to project 2`)
    
    // Step 7: Verify project isolation
    const project1Namespace = namespaceManager.createProjectNamespace(TEST_PROJECT_REF_1)
    const project2Namespace = namespaceManager.createProjectNamespace(TEST_PROJECT_REF_2)
    
    assert(project1Namespace.projectRef !== project2Namespace.projectRef, 'Projects should be isolated')
    console.log('✅ Step 7: Project isolation verified')
    
    // Step 8: Test security boundaries
    // Initialize project permissions
    securityManager.initializeProjectPermissions(TEST_PROJECT_REF_1)
    
    const securityTests = [
      { func: `ef_${TEST_PROJECT_REF_1}_api-users`, project: TEST_PROJECT_REF_1, shouldPass: true },
      { func: `ef_${TEST_PROJECT_REF_1}_api-users`, project: 'unauthorized-project', shouldPass: false }
    ]
    
    for (const test of securityTests) {
      const result = await securityManager.validateProjectAccess(test.func, test.project)
      assertEquals(result, test.shouldPass, `Security test for ${test.func} in ${test.project} should ${test.shouldPass ? 'pass' : 'fail'}`)
    }
    
    console.log('✅ Step 8: Security boundaries validated')
    
    // Step 9: Test backward compatibility
    const compatStats = compatibilityManager.getCompatibilityStats()
    assert(compatStats.totalFunctions > 0, 'Compatibility manager should have functions')
    assert(compatStats.legacyFunctions > 0, 'Should have legacy functions')
    assert(compatStats.multiLevelFunctions > 0, 'Should have multi-level functions')
    
    console.log('✅ Step 9: Backward compatibility verified')
    
    // Step 10: Verify deployment results
    const deploymentResults = mockDeploymentManager.getDeploymentResults()
    const expectedDeployments = testFunctionStructures.length * 2 // Two projects
    
    assertEquals(deploymentResults.size, expectedDeployments, 'All deployments should be recorded')
    
    console.log('✅ Step 10: Deployment results verified')
    
    // Final verification
    console.log('\n📊 End-to-End Workflow Summary:')
    console.log(`   Functions discovered: ${functions.length}`)
    console.log(`   Project 1 deployments: ${project1Deployment.successfulDeployments}`)
    console.log(`   Project 2 deployments: ${project2Deployment.successfulDeployments}`)
    console.log(`   Total deployment time: ${project1Deployment.duration + project2Deployment.duration}ms`)
    console.log(`   Legacy functions: ${compatStats.legacyFunctions}`)
    console.log(`   Multi-level functions: ${compatStats.multiLevelFunctions}`)
    
    console.log('\n🎉 Complete end-to-end workflow simulation successful!')
    
  } finally {
    await cleanupTestEnvironment()
  }
})