import { FunctionMetadata, FunctionDependency } from "./function-scanner.ts";

/**
 * Deployment order information
 */
export interface DeploymentOrder {
  functions: string[];
  batches: string[][];
  circularDependencies: CircularDependency[];
}

/**
 * Circular dependency information
 */
export interface CircularDependency {
  cycle: string[];
  type: 'direct' | 'indirect';
}

/**
 * Dependency graph node
 */
interface DependencyNode {
  functionPath: string;
  dependencies: Set<string>;
  dependents: Set<string>;
  visited: boolean;
  inStack: boolean;
}

/**
 * Dependency resolver for deployment ordering
 */
export class DependencyResolver {
  private dependencyGraph: Map<string, DependencyNode>;

  constructor() {
    this.dependencyGraph = new Map();
  }

  /**
   * Build dependency graph from function metadata
   */
  buildDependencyGraph(functions: FunctionMetadata[]): void {
    this.dependencyGraph.clear();

    // Initialize nodes
    for (const func of functions) {
      this.dependencyGraph.set(func.relativePath, {
        functionPath: func.relativePath,
        dependencies: new Set(),
        dependents: new Set(),
        visited: false,
        inStack: false
      });
    }

    // Build edges
    for (const func of functions) {
      const node = this.dependencyGraph.get(func.relativePath);
      if (!node) continue;

      for (const dependency of func.dependencies) {
        const targetPath = this.normalizeDependencyPath(dependency.targetFunction);
        
        // Only add dependency if target function exists in our graph
        if (this.dependencyGraph.has(targetPath)) {
          node.dependencies.add(targetPath);
          
          // Add reverse dependency
          const targetNode = this.dependencyGraph.get(targetPath);
          if (targetNode) {
            targetNode.dependents.add(func.relativePath);
          }
        }
      }
    }
  }

  /**
   * Calculate deployment order using topological sort
   * Returns functions in dependency order (dependencies first)
   */
  calculateDeploymentOrder(): DeploymentOrder {
    // Reset visited flags
    for (const node of this.dependencyGraph.values()) {
      node.visited = false;
      node.inStack = false;
    }

    const result: string[] = [];
    const circularDependencies: CircularDependency[] = [];
    const batches: string[][] = [];

    // Detect circular dependencies first
    const cycles = this.detectCircularDependencies();
    circularDependencies.push(...cycles);

    // If there are circular dependencies, we need to handle them
    if (cycles.length > 0) {
      console.warn(`Found ${cycles.length} circular dependencies`);
      // For now, we'll still try to create a deployment order
      // In a production system, this might require manual intervention
    }

    // Perform topological sort using DFS
    const visited = new Set<string>();
    const stack: string[] = [];

    for (const [functionPath] of this.dependencyGraph) {
      if (!visited.has(functionPath)) {
        this.topologicalSortDFS(functionPath, visited, stack);
      }
    }

    // Stack already has correct order (dependencies first)
    result.push(...stack);

    // Create batches for parallel deployment
    const batchGroups = this.createDeploymentBatches(result);
    batches.push(...batchGroups);

    return {
      functions: result,
      batches,
      circularDependencies
    };
  }

  /**
   * Detect circular dependencies in the graph
   */
  detectCircularDependencies(): CircularDependency[] {
    const cycles: CircularDependency[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    for (const [functionPath] of this.dependencyGraph) {
      if (!visited.has(functionPath)) {
        this.detectCyclesDFS(functionPath, visited, recursionStack, path, cycles);
      }
    }

    return cycles;
  }

  /**
   * Check if a specific circular dependency exists between two functions
   */
  hasCircularDependency(functionA: string, functionB: string): boolean {
    // Check if A depends on B and B depends on A (direct or indirect)
    return this.hasDependencyPath(functionA, functionB) && 
           this.hasDependencyPath(functionB, functionA);
  }

  /**
   * Check if there's a dependency path from source to target
   */
  hasDependencyPath(source: string, target: string): boolean {
    if (source === target) return true;

    const visited = new Set<string>();
    const queue: string[] = [source];
    visited.add(source);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = this.dependencyGraph.get(current);
      
      if (!node) continue;

      for (const dependency of node.dependencies) {
        if (dependency === target) {
          return true;
        }
        
        if (!visited.has(dependency)) {
          visited.add(dependency);
          queue.push(dependency);
        }
      }
    }

    return false;
  }

  /**
   * Get functions that have no dependencies (can be deployed first)
   */
  getRootFunctions(): string[] {
    const roots: string[] = [];
    
    for (const [functionPath, node] of this.dependencyGraph) {
      if (node.dependencies.size === 0) {
        roots.push(functionPath);
      }
    }
    
    return roots;
  }

  /**
   * Get functions that nothing depends on (can be deployed last)
   */
  getLeafFunctions(): string[] {
    const leaves: string[] = [];
    
    for (const [functionPath, node] of this.dependencyGraph) {
      if (node.dependents.size === 0) {
        leaves.push(functionPath);
      }
    }
    
    return leaves;
  }

  /**
   * Get direct dependencies of a function
   */
  getDirectDependencies(functionPath: string): string[] {
    const node = this.dependencyGraph.get(functionPath);
    return node ? Array.from(node.dependencies) : [];
  }

  /**
   * Get direct dependents of a function
   */
  getDirectDependents(functionPath: string): string[] {
    const node = this.dependencyGraph.get(functionPath);
    return node ? Array.from(node.dependents) : [];
  }

  /**
   * Normalize dependency path for consistent comparison
   */
  private normalizeDependencyPath(path: string): string {
    // Remove leading ./ or ../
    let normalized = path.replace(/^\.\//, '').replace(/^\.\.\//, '');
    
    // Handle relative paths that go up directories
    const parts = normalized.split('/');
    const resolvedParts: string[] = [];
    
    for (const part of parts) {
      if (part === '..') {
        resolvedParts.pop();
      } else if (part !== '.' && part !== '') {
        resolvedParts.push(part);
      }
    }
    
    return resolvedParts.join('/');
  }

  /**
   * Topological sort using DFS
   */
  private topologicalSortDFS(
    functionPath: string, 
    visited: Set<string>, 
    stack: string[]
  ): void {
    visited.add(functionPath);
    
    const node = this.dependencyGraph.get(functionPath);
    if (!node) return;

    // Visit all dependencies first
    for (const dependency of node.dependencies) {
      if (!visited.has(dependency)) {
        this.topologicalSortDFS(dependency, visited, stack);
      }
    }

    // Add current function to stack after all dependencies
    stack.push(functionPath);
  }

  /**
   * Detect cycles using DFS
   */
  private detectCyclesDFS(
    functionPath: string,
    visited: Set<string>,
    recursionStack: Set<string>,
    path: string[],
    cycles: CircularDependency[]
  ): void {
    visited.add(functionPath);
    recursionStack.add(functionPath);
    path.push(functionPath);

    const node = this.dependencyGraph.get(functionPath);
    if (!node) return;

    for (const dependency of node.dependencies) {
      if (!visited.has(dependency)) {
        this.detectCyclesDFS(dependency, visited, recursionStack, path, cycles);
      } else if (recursionStack.has(dependency)) {
        // Found a cycle
        const cycleStart = path.indexOf(dependency);
        const cycle = path.slice(cycleStart).concat([dependency]);
        
        cycles.push({
          cycle,
          type: cycle.length === 3 ? 'direct' : 'indirect'
        });
      }
    }

    recursionStack.delete(functionPath);
    path.pop();
  }

  /**
   * Create deployment batches for parallel deployment
   * Functions in the same batch can be deployed in parallel
   */
  private createDeploymentBatches(orderedFunctions: string[]): string[][] {
    const batches: string[][] = [];
    const deployed = new Set<string>();
    const allFunctions = new Set(orderedFunctions);
    
    while (deployed.size < allFunctions.size) {
      const currentBatch: string[] = [];
      
      // Find all functions whose dependencies are already deployed
      for (const functionPath of allFunctions) {
        if (deployed.has(functionPath)) continue;
        
        const node = this.dependencyGraph.get(functionPath);
        if (!node) continue;
        
        // Check if all dependencies are already deployed
        const allDependenciesDeployed = Array.from(node.dependencies)
          .every(dep => deployed.has(dep));
        
        if (allDependenciesDeployed) {
          currentBatch.push(functionPath);
        }
      }
      
      // Mark all functions in current batch as deployed
      for (const functionPath of currentBatch) {
        deployed.add(functionPath);
      }
      
      if (currentBatch.length === 0) {
        // This shouldn't happen unless there are circular dependencies
        // Add remaining functions to break the deadlock
        const remaining = Array.from(allFunctions).filter(f => !deployed.has(f));
        if (remaining.length > 0) {
          currentBatch.push(remaining[0]);
          deployed.add(remaining[0]);
        }
      }
      
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
    }
    
    return batches;
  }

  /**
   * Validate the dependency graph for common issues
   */
  validateDependencyGraph(): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for circular dependencies
    const cycles = this.detectCircularDependencies();
    if (cycles.length > 0) {
      errors.push(`Found ${cycles.length} circular dependencies`);
      for (const cycle of cycles) {
        errors.push(`Circular dependency: ${cycle.cycle.join(' -> ')}`);
      }
    }

    // Check for missing dependencies
    for (const [functionPath, node] of this.dependencyGraph) {
      for (const dependency of node.dependencies) {
        if (!this.dependencyGraph.has(dependency)) {
          warnings.push(`Function '${functionPath}' depends on '${dependency}' which is not found`);
        }
      }
    }

    // Check for isolated functions
    const isolatedFunctions = this.getIsolatedFunctions();
    if (isolatedFunctions.length > 0) {
      warnings.push(`Found ${isolatedFunctions.length} isolated functions: ${isolatedFunctions.join(', ')}`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Get functions that have no dependencies and no dependents
   */
  private getIsolatedFunctions(): string[] {
    const isolated: string[] = [];
    
    for (const [functionPath, node] of this.dependencyGraph) {
      if (node.dependencies.size === 0 && node.dependents.size === 0) {
        isolated.push(functionPath);
      }
    }
    
    return isolated;
  }
}