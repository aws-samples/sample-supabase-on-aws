/**
 * Example usage of the Enhanced Edge Functions components
 * This demonstrates how to use the cross-directory resolver and dependency resolver
 */

import { EnhancedFunctionScanner } from "./function-scanner.ts";
import { EnhancedCrossDirectoryResolver } from "./cross-directory-resolver.ts";
import { DependencyResolver } from "./dependency-resolver.ts";
import { EnhancedNamespaceManager } from "./namespace-manager.ts";
import { EnhancedSecurityManager, ResourceAccessRequest, SecurityViolationType } from "./security-manager.ts";
import { EnhancedEdgeFunctionsManager } from "./index.ts";

/**
 * Example: Setting up and using the enhanced edge functions system
 */
async function exampleUsage() {
  const functionsRootPath = "./supabase/functions";
  
  try {
    // Initialize the enhanced edge functions manager
    const manager = new EnhancedEdgeFunctionsManager(functionsRootPath);
    await manager.initialize();
    
    console.log("✅ Enhanced Edge Functions Manager initialized");
    
    // Get the components
    const scanner = manager.getScanner();
    const resolver = manager.getResolver();
    const dependencyResolver = manager.getDependencyResolver();
    const namespaceManager = manager.getNamespaceManager();
    const securityManager = manager.getSecurityManager();
    
    // Example 1: Scan for functions
    console.log("\n📁 Scanning for functions...");
    const functions = await scanner.scanFunctions(functionsRootPath);
    console.log(`Found ${functions.length} functions:`);
    functions.forEach((func: any) => {
      console.log(`  - ${func.relativePath} (${func.dependencies.length} dependencies)`);
    });
    
    // Example 2: Resolve cross-directory function paths
    console.log("\n🔗 Testing cross-directory resolution...");
    if (functions.length >= 2) {
      const fromFunction = functions[0].relativePath;
      const toFunction = functions[1].relativePath;
      
      try {
        const resolvedPath = resolver.resolveFunctionPath(fromFunction, toFunction);
        console.log(`  ✅ Resolved path from '${fromFunction}' to '${toFunction}': ${resolvedPath}`);
        
        // Validate the call
        const isValid = resolver.validateCrossDirectoryCall(fromFunction, toFunction);
        console.log(`  ${isValid ? '✅' : '❌'} Cross-directory call validation: ${isValid}`);
        
        // Create a function proxy
        const proxy = resolver.createFunctionProxy(toFunction);
        console.log(`  ✅ Created function proxy for '${toFunction}'`);
      } catch (error) {
        console.log(`  ❌ Resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Example 3: Calculate deployment order
    console.log("\n📦 Calculating deployment order...");
    const deploymentOrder = dependencyResolver.calculateDeploymentOrder();
    
    console.log(`  Functions in dependency order: ${deploymentOrder.functions.join(' -> ')}`);
    console.log(`  Deployment batches (can be deployed in parallel):`);
    deploymentOrder.batches.forEach((batch: any, index: number) => {
      console.log(`    Batch ${index + 1}: [${batch.join(', ')}]`);
    });
    
    if (deploymentOrder.circularDependencies.length > 0) {
      console.log(`  ⚠️  Found ${deploymentOrder.circularDependencies.length} circular dependencies:`);
      deploymentOrder.circularDependencies.forEach((cycle: any) => {
        console.log(`    ${cycle.type}: ${cycle.cycle.join(' -> ')}`);
      });
    } else {
      console.log(`  ✅ No circular dependencies found`);
    }
    
    // Example 4: Validate the system
    console.log("\n🔍 Validating system...");
    const validation = await manager.validate();
    
    if (validation.isValid) {
      console.log("  ✅ System validation passed");
    } else {
      console.log("  ❌ System validation failed:");
      validation.errors.forEach((error: any) => console.log(`    Error: ${error}`));
    }
    
    if (validation.warnings.length > 0) {
      console.log("  ⚠️  Warnings:");
      validation.warnings.forEach((warning: any) => console.log(`    Warning: ${warning}`));
    }
    
    // Example 5: Demonstrate namespace management
    console.log("\n🏢 Testing project namespace management...");
    
    // Create project namespaces
    const project1 = "my-app-prod";
    const project2 = "my-app-staging";
    
    const namespace1 = namespaceManager.createProjectNamespace(project1);
    const namespace2 = namespaceManager.createProjectNamespace(project2);
    
    console.log(`  ✅ Created namespaces for projects: ${project1}, ${project2}`);
    
    // Register functions in different projects
    if (functions.length > 0) {
      const func = functions[0];
      
      // Create function instances for different projects
      const prodFunction = {
        id: `${func.id}-prod`,
        name: func.name,
        path: func.path,
        relativePath: func.relativePath,
        projectRef: project1,
        namespacedId: "",
        createdAt: new Date(),
        updatedAt: new Date()
      };
      
      const stagingFunction = {
        id: `${func.id}-staging`,
        name: func.name,
        path: func.path,
        relativePath: func.relativePath,
        projectRef: project2,
        namespacedId: "",
        createdAt: new Date(),
        updatedAt: new Date()
      };
      
      namespaceManager.registerFunction(prodFunction);
      namespaceManager.registerFunction(stagingFunction);
      
      console.log(`  ✅ Registered function '${func.name}' in both projects`);
      
      // Test isolation
      const prodAccess = namespaceManager.validateProjectAccess(prodFunction.namespacedId, project1);
      const stagingAccess = namespaceManager.validateProjectAccess(stagingFunction.namespacedId, project2);
      const crossAccess = namespaceManager.validateProjectAccess(prodFunction.namespacedId, project2);
      
      console.log(`  ${prodAccess ? '✅' : '❌'} Production function access validation: ${prodAccess}`);
      console.log(`  ${stagingAccess ? '✅' : '❌'} Staging function access validation: ${stagingAccess}`);
      console.log(`  ${!crossAccess ? '✅' : '❌'} Cross-project access denied: ${!crossAccess}`);
      
      // Set project-specific environment variables
      namespaceManager.setProjectEnvironmentVariables(project1, new Map([
        ["DATABASE_URL", "prod-database-url"],
        ["API_KEY", "prod-api-key"]
      ]));
      
      namespaceManager.setProjectEnvironmentVariables(project2, new Map([
        ["DATABASE_URL", "staging-database-url"],
        ["API_KEY", "staging-api-key"]
      ]));
      
      console.log(`  ✅ Set project-specific environment variables`);
      
      // List functions in each project
      const prodFunctions = namespaceManager.listProjectFunctions(project1);
      const stagingFunctions = namespaceManager.listProjectFunctions(project2);
      
      console.log(`  📋 Production functions: ${prodFunctions.length}`);
      console.log(`  📋 Staging functions: ${stagingFunctions.length}`);
    }
    
    // Example 6: Demonstrate security management
    console.log("\n🔒 Testing security management...");
    
    // Initialize project permissions
    securityManager.initializeProjectPermissions(project1);
    securityManager.initializeProjectPermissions(project2);
    
    if (functions.length > 0) {
      const func = functions[0];
      const functionId = `ef_${project1}_${func.name}`;
      
      // Test valid project access
      const validAccess = await securityManager.validateProjectAccess(functionId, project1);
      console.log(`  ${validAccess ? '✅' : '❌'} Valid project access: ${validAccess}`);
      
      // Test cross-project access (should be denied)
      const crossProjectAccess = await securityManager.validateProjectAccess(functionId, project2);
      console.log(`  ${!crossProjectAccess ? '✅' : '❌'} Cross-project access denied: ${!crossProjectAccess}`);
      
      // Test resource access validation
      const resourceRequest: ResourceAccessRequest = {
        functionId,
        projectRef: project1,
        resourceType: 'database',
        resourceId: `${project1}_table_users`,
        operation: 'read'
      };
      
      const resourceAccess = await securityManager.validateResourceAccess(resourceRequest);
      console.log(`  ${resourceAccess ? '✅' : '❌'} Resource access validation: ${resourceAccess}`);
      
      // Test cross-project function call validation
      const crossFunctionCall = await securityManager.validateCrossProjectCall(
        project1, 
        project2, 
        'targetFunction'
      );
      console.log(`  ${!crossFunctionCall ? '✅' : '❌'} Cross-project function call denied: ${!crossFunctionCall}`);
      
      // Create security context
      try {
        const securityContext = await securityManager.createSecurityContext(functionId, project1);
        console.log(`  ✅ Created security context for function in project ${securityContext.projectRef}`);
        console.log(`  🔐 Security context has ${securityContext.permissions.size} permissions`);
      } catch (error) {
        console.log(`  ❌ Failed to create security context: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      // Check security violations
      const violations = securityManager.getSecurityViolations();
      console.log(`  📊 Total security violations logged: ${violations.length}`);
      
      const projectViolations = securityManager.getProjectViolations(project1);
      console.log(`  📊 Violations for ${project1}: ${projectViolations.length}`);
    }
    
  } catch (error) {
    console.error("❌ Example failed:", error);
  }
}

/**
 * Example: Manual usage of individual components
 */
async function manualComponentUsage() {
  const functionsRootPath = "./supabase/functions";
  
  console.log("\n🔧 Manual component usage example...");
  
  // 1. Use the function scanner directly
  const scanner = new EnhancedFunctionScanner();
  const functions = await scanner.scanFunctions(functionsRootPath);
  
  // 2. Create a registry for the resolver
  const registry = new Map();
  functions.forEach((func: any) => registry.set(func.id, func));
  
  // 3. Use the cross-directory resolver
  const resolver = new EnhancedCrossDirectoryResolver(functionsRootPath, registry);
  
  // 4. Use the dependency resolver
  const dependencyResolver = new DependencyResolver();
  dependencyResolver.buildDependencyGraph(functions);
  
  // 5. Use the namespace manager
  const namespaceManager = new EnhancedNamespaceManager("manual");
  
  // 6. Use the security manager
  const securityManager = new EnhancedSecurityManager();
  
  console.log("  ✅ All components initialized manually");
  
  // Example: Check for specific dependencies
  if (functions.length > 0) {
    const firstFunction = functions[0].relativePath;
    const dependencies = dependencyResolver.getDirectDependencies(firstFunction);
    const dependents = dependencyResolver.getDirectDependents(firstFunction);
    
    console.log(`  Function '${firstFunction}':`);
    console.log(`    Dependencies: [${dependencies.join(', ')}]`);
    console.log(`    Dependents: [${dependents.join(', ')}]`);
  }
}

// Export the example functions for use in other contexts
export { exampleUsage, manualComponentUsage };

// Example execution function (can be called manually)
export async function runExamples() {
  console.log("🚀 Enhanced Edge Functions Example Usage\n");
  
  await exampleUsage();
  await manualComponentUsage();
  
  console.log("\n✨ Example completed!");
}