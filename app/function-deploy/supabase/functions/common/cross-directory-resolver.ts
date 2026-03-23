import { join, resolve, relative, isAbsolute } from "https://deno.land/std@0.208.0/path/mod.ts";
import { FunctionMetadata } from "./function-scanner.ts";

/**
 * Execution context for function calls
 */
export interface ExecutionContext {
  projectRef: string;
  requestId: string;
  headers: Headers;
  environment: Record<string, string>;
}

/**
 * Function proxy for cross-directory invocations
 */
export interface FunctionProxy {
  invoke(payload: any, context: ExecutionContext): Promise<Response>;
}

/**
 * Cross-directory function resolver interface
 */
export interface CrossDirectoryResolver {
  resolveFunctionPath(fromPath: string, targetFunction: string): string;
  validateCrossDirectoryCall(caller: string, target: string): boolean;
  createFunctionProxy(targetFunction: string): FunctionProxy;
}

/**
 * Implementation of cross-directory function resolver
 */
export class EnhancedCrossDirectoryResolver implements CrossDirectoryResolver {
  private functionsRegistry: Map<string, FunctionMetadata>;
  private functionsRootPath: string;

  constructor(functionsRootPath: string, functionsRegistry?: Map<string, FunctionMetadata>) {
    this.functionsRootPath = resolve(functionsRootPath);
    this.functionsRegistry = functionsRegistry || new Map();
  }

  /**
   * Update the functions registry
   */
  updateRegistry(functionsRegistry: Map<string, FunctionMetadata>): void {
    this.functionsRegistry = functionsRegistry;
  }

  /**
   * Resolve function path from one function to another
   * Supports both relative and absolute paths within the functions directory
   */
  resolveFunctionPath(fromPath: string, targetFunction: string): string {
    try {
      // Normalize the fromPath to be relative to functions root
      const normalizedFromPath = this.normalizePath(fromPath);
      
      // Handle different target function formats
      let resolvedPath: string;
      
      if (targetFunction.startsWith('./') || targetFunction.startsWith('../')) {
        // Relative path resolution
        const fromDir = join(this.functionsRootPath, normalizedFromPath);
        const parentDir = resolve(fromDir, '..');
        resolvedPath = resolve(parentDir, targetFunction);
      } else if (targetFunction.startsWith('/')) {
        // Absolute path - check if it's trying to access system paths
        if (targetFunction.startsWith('/etc/') || targetFunction.startsWith('/usr/') || 
            targetFunction.startsWith('/var/') || targetFunction.startsWith('/home/') ||
            targetFunction.startsWith('/root/') || targetFunction.startsWith('/tmp/')) {
          throw new Error(`Target function path '${targetFunction}' not found`);
        }
        // Absolute path within functions directory
        resolvedPath = join(this.functionsRootPath, targetFunction.substring(1));
      } else {
        // Direct function name - resolve from functions root
        resolvedPath = join(this.functionsRootPath, targetFunction);
      }

      // Ensure the resolved path is within the functions directory
      const relativePath = relative(this.functionsRootPath, resolvedPath);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error(`Target function path '${targetFunction}' resolves outside functions directory`);
      }

      return relativePath;
    } catch (error) {
      throw new Error(`Failed to resolve function path from '${fromPath}' to '${targetFunction}': ${(error as Error).message}`);
    }
  }

  /**
   * Validate that a cross-directory call is permitted
   * Checks security boundaries and function existence
   */
  validateCrossDirectoryCall(caller: string, target: string): boolean {
    try {
      // Normalize paths
      const normalizedCaller = this.normalizePath(caller);
      const normalizedTarget = this.normalizePath(target);

      // Check if both functions exist in registry
      const callerExists = this.functionExistsInRegistry(normalizedCaller);
      const targetExists = this.functionExistsInRegistry(normalizedTarget);

      if (!callerExists) {
        console.warn(`Caller function '${normalizedCaller}' not found in registry`);
        return false;
      }

      if (!targetExists) {
        console.warn(`Target function '${normalizedTarget}' not found in registry`);
        return false;
      }

      // Additional security checks can be added here
      // For now, allow all calls within the same project
      
      // Prevent self-calls to avoid infinite recursion
      if (normalizedCaller === normalizedTarget) {
        console.warn(`Function '${normalizedCaller}' attempted to call itself`);
        return false;
      }

      // Check for potential circular dependencies
      if (this.hasCircularDependency(normalizedCaller, normalizedTarget)) {
        console.warn(`Circular dependency detected between '${normalizedCaller}' and '${normalizedTarget}'`);
        return false;
      }

      return true;
    } catch (error) {
      console.error(`Error validating cross-directory call from '${caller}' to '${target}':`, error);
      return false;
    }
  }

  /**
   * Create a function proxy for cross-directory invocation
   */
  createFunctionProxy(targetFunction: string): FunctionProxy {
    const normalizedTarget = this.normalizePath(targetFunction);
    const resolver = this; // Capture 'this' context
    
    return {
      async invoke(payload: any, context: ExecutionContext): Promise<Response> {
        try {
          // Validate the target function exists
          if (!resolver.functionExistsInRegistry(normalizedTarget)) {
            throw new Error(`Target function '${targetFunction}' not found`);
          }

          // Get function metadata
          const functionMetadata = resolver.getFunctionMetadata(normalizedTarget);
          if (!functionMetadata) {
            throw new Error(`Function metadata not found for '${targetFunction}'`);
          }

          // Load the target function module
          const functionPath = resolve(resolver.functionsRootPath, normalizedTarget);
          const indexPath = join(functionPath, 'index.ts');
          
          // Check if the function file exists
          if (!resolver.fileExists(indexPath)) {
            const jsIndexPath = join(functionPath, 'index.js');
            if (!resolver.fileExists(jsIndexPath)) {
              throw new Error(`Function entry point not found for '${targetFunction}'`);
            }
          }

          // Import and execute the function
          // Note: In a real implementation, this would need to handle the Deno module loading
          // and execution context properly. This is a simplified version.
          const moduleUrl = `file://${indexPath}`;
          const module = await import(moduleUrl);
          
          // Assume the function exports a default handler
          if (typeof module.default !== 'function') {
            throw new Error(`Function '${targetFunction}' does not export a default handler`);
          }

          // Create a request object from the payload
          const request = new Request('http://localhost', {
            method: 'POST',
            headers: context.headers,
            body: JSON.stringify(payload)
          });

          // Execute the function with the provided context
          const response = await module.default(request);
          
          return response;
        } catch (error) {
          console.error(`Error invoking function '${targetFunction}':`, error);
          
          // Return an error response
          return new Response(
            JSON.stringify({
              error: 'Function invocation failed',
              message: (error as Error).message,
              target: targetFunction
            }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }
      }
    };
  }

  /**
   * Normalize a path to be relative to the functions root
   */
  private normalizePath(path: string): string {
    if (isAbsolute(path)) {
      return relative(this.functionsRootPath, path);
    }
    return path;
  }

  /**
   * Check if a function exists at the given path
   */
  private functionExists(relativePath: string): boolean {
    const functionPath = join(this.functionsRootPath, relativePath);
    const indexTsPath = join(functionPath, 'index.ts');
    const indexJsPath = join(functionPath, 'index.js');
    
    return this.fileExists(indexTsPath) || this.fileExists(indexJsPath);
  }

  /**
   * Check if a function exists in the registry
   */
  private functionExistsInRegistry(relativePath: string): boolean {
    for (const [_, metadata] of this.functionsRegistry) {
      if (metadata.relativePath === relativePath || metadata.name === relativePath) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get function metadata from registry
   */
  private getFunctionMetadata(relativePath: string): FunctionMetadata | null {
    for (const [_, metadata] of this.functionsRegistry) {
      if (metadata.relativePath === relativePath || metadata.name === relativePath) {
        return metadata;
      }
    }
    return null;
  }

  /**
   * Check if a file exists
   */
  private fileExists(path: string): boolean {
    try {
      return Deno.statSync(path).isFile;
    } catch {
      return false;
    }
  }

  /**
   * Check for circular dependencies between functions
   * This is a simplified implementation - a full implementation would
   * need to traverse the entire dependency graph
   */
  private hasCircularDependency(caller: string, target: string): boolean {
    const callerMetadata = this.getFunctionMetadata(caller);
    const targetMetadata = this.getFunctionMetadata(target);
    
    if (!callerMetadata || !targetMetadata) {
      return false;
    }

    // Check if target has a dependency back to caller
    for (const dependency of targetMetadata.dependencies) {
      if (dependency.targetFunction === caller || 
          dependency.targetPath.includes(caller)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get all functions that depend on the given function
   */
  getDependentFunctions(functionPath: string): string[] {
    const dependents: string[] = [];
    const normalizedPath = this.normalizePath(functionPath);
    
    for (const [_, metadata] of this.functionsRegistry) {
      for (const dependency of metadata.dependencies) {
        if (dependency.targetFunction === normalizedPath ||
            dependency.targetPath.includes(normalizedPath)) {
          dependents.push(metadata.relativePath);
        }
      }
    }
    
    return dependents;
  }

  /**
   * Get all functions that the given function depends on
   */
  getFunctionDependencies(functionPath: string): string[] {
    const normalizedPath = this.normalizePath(functionPath);
    const metadata = this.getFunctionMetadata(normalizedPath);
    
    if (!metadata) {
      return [];
    }
    
    return metadata.dependencies.map(dep => dep.targetFunction);
  }
}