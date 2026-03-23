// Enhanced Edge Functions Common Module
// This module exports all the enhanced functionality for multi-level directory support

import { EnhancedFunctionScanner, type FunctionMetadata } from "./function-scanner.ts";
import { EnhancedCrossDirectoryResolver } from "./cross-directory-resolver.ts";
import { DependencyResolver, type DeploymentOrder } from "./dependency-resolver.ts";
import { EnhancedNamespaceManager } from "./namespace-manager.ts";
import { EnhancedSecurityManager } from "./security-manager.ts";

export { 
  EnhancedFunctionScanner,
  type FunctionScanner,
  type FunctionMetadata,
  type FunctionDependency
} from "./function-scanner.ts";

export {
  EnvironmentLoader,
  type EnvironmentConfig
} from "./environment-loader.ts";

export {
  EnhancedCrossDirectoryResolver,
  type CrossDirectoryResolver,
  type FunctionProxy,
  type ExecutionContext
} from "./cross-directory-resolver.ts";

export {
  DependencyResolver,
  type DeploymentOrder,
  type CircularDependency
} from "./dependency-resolver.ts";

export {
  EnhancedNamespaceManager,
  type NamespaceManager,
  type ProjectNamespace,
  type ProjectCredentials,
  type FunctionInstance
} from "./namespace-manager.ts";

export {
  EnhancedSecurityManager,
  type SecurityManager,
  type SecurityViolation,
  type ResourceAccessRequest,
  type SecurityContext,
  SecurityViolationType
} from "./security-manager.ts";

/**
 * Enhanced Edge Functions Manager
 * Coordinates all the enhanced functionality
 */
export class EnhancedEdgeFunctionsManager {
  private scanner: EnhancedFunctionScanner;
  private resolver: EnhancedCrossDirectoryResolver;
  private dependencyResolver: DependencyResolver;
  private namespaceManager: EnhancedNamespaceManager;
  private securityManager: EnhancedSecurityManager;
  private functionsRootPath: string;

  constructor(functionsRootPath: string, namespacePrefix?: string) {
    this.functionsRootPath = functionsRootPath;
    this.scanner = new EnhancedFunctionScanner();
    this.resolver = new EnhancedCrossDirectoryResolver(functionsRootPath);
    this.dependencyResolver = new DependencyResolver();
    this.namespaceManager = new EnhancedNamespaceManager(namespacePrefix);
    this.securityManager = new EnhancedSecurityManager();
  }

  /**
   * Initialize the manager by scanning functions and building dependency graph
   */
  async initialize(): Promise<void> {
    try {
      // Scan all functions
      const functions = await this.scanner.scanFunctions(this.functionsRootPath);
      
      // Build registry for cross-directory resolver
      const registry = new Map();
      for (const func of functions) {
        registry.set(func.id, func);
      }
      this.resolver.updateRegistry(registry);
      
      // Build dependency graph
      this.dependencyResolver.buildDependencyGraph(functions);
      
      console.log(`Initialized Enhanced Edge Functions Manager with ${functions.length} functions`);
    } catch (error) {
      console.error('Failed to initialize Enhanced Edge Functions Manager:', error);
      throw error;
    }
  }

  /**
   * Get the function scanner
   */
  getScanner(): EnhancedFunctionScanner {
    return this.scanner;
  }

  /**
   * Get the cross-directory resolver
   */
  getResolver(): EnhancedCrossDirectoryResolver {
    return this.resolver;
  }

  /**
   * Get the dependency resolver
   */
  getDependencyResolver(): DependencyResolver {
    return this.dependencyResolver;
  }

  /**
   * Get the namespace manager
   */
  getNamespaceManager(): EnhancedNamespaceManager {
    return this.namespaceManager;
  }

  /**
   * Get the security manager
   */
  getSecurityManager(): EnhancedSecurityManager {
    return this.securityManager;
  }

  /**
   * Get deployment order for all functions
   */
  getDeploymentOrder(): DeploymentOrder {
    return this.dependencyResolver.calculateDeploymentOrder();
  }

  /**
   * Validate the entire system
   */
  async validate(): Promise<{
    isValid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Validate dependency graph
      const depValidation = this.dependencyResolver.validateDependencyGraph();
      errors.push(...depValidation.errors);
      warnings.push(...depValidation.warnings);

      // Validate function structures
      const functions = await this.scanner.scanFunctions(this.functionsRootPath);
      for (const func of functions) {
        if (!this.scanner.validateFunctionStructure(func.path)) {
          errors.push(`Invalid function structure: ${func.relativePath}`);
        }
      }

      // Validate namespace manager
      const namespaceValidation = this.namespaceManager.validate();
      errors.push(...namespaceValidation.errors);
      warnings.push(...namespaceValidation.warnings);

      // Validate security manager
      const securityValidation = this.securityManager.validate();
      errors.push(...securityValidation.errors);
      warnings.push(...securityValidation.warnings);

    } catch (error) {
      errors.push(`Validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}