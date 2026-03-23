// Enhanced Edge Functions Namespace Manager
// Provides project isolation and namespace management for multi-project environments

/**
 * Project credentials for Edge Functions context
 */
export interface ProjectCredentials {
  serviceRoleKey: string;
  anonKey: string;
  supabaseUrl: string;
}

/**
 * Function instance within a project namespace
 */
export interface FunctionInstance {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  projectRef: string;
  namespacedId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Project namespace containing isolated functions and configuration
 */
export interface ProjectNamespace {
  projectRef: string;
  functions: Map<string, FunctionInstance>;
  environmentVariables: Map<string, string>;
  credentials: ProjectCredentials;
}

/**
 * Namespace Manager interface for project isolation
 */
export interface NamespaceManager {
  createProjectNamespace(projectRef: string): ProjectNamespace;
  isolateFunction(functionName: string, projectRef: string): string;
  validateProjectAccess(functionId: string, projectRef: string): boolean;
}

/**
 * Enhanced Namespace Manager implementation
 * Provides project isolation mechanisms and namespace management
 */
export class EnhancedNamespaceManager implements NamespaceManager {
  private namespaces: Map<string, ProjectNamespace>;
  private functionToProject: Map<string, string>;
  private namespacePrefix: string;

  constructor(namespacePrefix: string = 'ef') {
    this.namespaces = new Map();
    this.functionToProject = new Map();
    this.namespacePrefix = namespacePrefix;
  }

  /**
   * Create a new project namespace with isolation
   * @param projectRef - Unique project reference identifier
   * @returns ProjectNamespace with isolated environment
   */
  createProjectNamespace(projectRef: string): ProjectNamespace {
    if (!projectRef || typeof projectRef !== 'string') {
      throw new Error('Project reference must be a non-empty string');
    }

    // Check if namespace already exists
    if (this.namespaces.has(projectRef)) {
      return this.namespaces.get(projectRef)!;
    }

    // Create new namespace with default credentials (to be populated later)
    const namespace: ProjectNamespace = {
      projectRef,
      functions: new Map<string, FunctionInstance>(),
      environmentVariables: new Map<string, string>(),
      credentials: {
        serviceRoleKey: '',
        anonKey: '',
        supabaseUrl: ''
      }
    };

    this.namespaces.set(projectRef, namespace);
    
    console.log(`Created project namespace: ${projectRef}`);
    return namespace;
  }

  /**
   * Isolate a function within a project namespace
   * @param functionName - Original function name
   * @param projectRef - Project reference for isolation
   * @returns Namespaced function identifier
   */
  isolateFunction(functionName: string, projectRef: string): string {
    if (!functionName || typeof functionName !== 'string') {
      throw new Error('Function name must be a non-empty string');
    }

    if (!projectRef || typeof projectRef !== 'string') {
      throw new Error('Project reference must be a non-empty string');
    }

    // Ensure namespace exists
    if (!this.namespaces.has(projectRef)) {
      this.createProjectNamespace(projectRef);
    }

    // Generate namespaced function ID
    const namespacedId = `${this.namespacePrefix}_${projectRef}_${functionName}`;
    
    // Track function to project mapping
    this.functionToProject.set(namespacedId, projectRef);
    this.functionToProject.set(functionName, projectRef);

    console.log(`Isolated function '${functionName}' to namespace '${projectRef}' as '${namespacedId}'`);
    return namespacedId;
  }

  /**
   * Validate that a function belongs to the specified project
   * @param functionId - Function identifier (namespaced or original)
   * @param projectRef - Project reference to validate against
   * @returns True if function belongs to project, false otherwise
   */
  validateProjectAccess(functionId: string, projectRef: string): boolean {
    if (!functionId || typeof functionId !== 'string') {
      return false;
    }

    if (!projectRef || typeof projectRef !== 'string') {
      return false;
    }

    // Check if function is tracked in our mapping (direct lookup)
    const functionProject = this.functionToProject.get(functionId);
    if (functionProject) {
      return functionProject === projectRef;
    }

    // Check with project-scoped name
    const projectScopedName = `${projectRef}:${functionId}`;
    const scopedProject = this.functionToProject.get(projectScopedName);
    if (scopedProject) {
      return scopedProject === projectRef;
    }

    // Check if functionId is already namespaced for this project
    const expectedNamespacedId = `${this.namespacePrefix}_${projectRef}_`;
    if (functionId.startsWith(expectedNamespacedId)) {
      return true;
    }

    // Check if function exists in the project namespace
    const namespace = this.namespaces.get(projectRef);
    if (namespace) {
      return namespace.functions.has(functionId);
    }

    return false;
  }

  /**
   * Register a function instance in a project namespace
   * @param functionInstance - Function instance to register
   */
  registerFunction(functionInstance: FunctionInstance): void {
    const { projectRef, name } = functionInstance;
    
    // Ensure namespace exists
    if (!this.namespaces.has(projectRef)) {
      this.createProjectNamespace(projectRef);
    }

    const namespace = this.namespaces.get(projectRef)!;
    
    // Generate namespaced ID if not already set
    if (!functionInstance.namespacedId) {
      functionInstance.namespacedId = this.isolateFunction(name, projectRef);
    }

    // Register function in namespace
    namespace.functions.set(name, functionInstance);
    namespace.functions.set(functionInstance.namespacedId, functionInstance);
    
    // Update function to project mapping - use unique keys to avoid conflicts
    const projectScopedName = `${projectRef}:${name}`;
    this.functionToProject.set(projectScopedName, projectRef);
    this.functionToProject.set(functionInstance.namespacedId, projectRef);
    this.functionToProject.set(functionInstance.id, projectRef);

    console.log(`Registered function '${name}' in project '${projectRef}'`);
  }

  /**
   * Update project credentials for a namespace
   * @param projectRef - Project reference
   * @param credentials - New credentials to set
   */
  updateProjectCredentials(projectRef: string, credentials: ProjectCredentials): void {
    const namespace = this.namespaces.get(projectRef);
    if (!namespace) {
      throw new Error(`Project namespace not found: ${projectRef}`);
    }

    namespace.credentials = { ...credentials };
    console.log(`Updated credentials for project: ${projectRef}`);
  }

  /**
   * Set environment variables for a project namespace
   * @param projectRef - Project reference
   * @param envVars - Environment variables to set
   */
  setProjectEnvironmentVariables(projectRef: string, envVars: Map<string, string>): void {
    const namespace = this.namespaces.get(projectRef);
    if (!namespace) {
      throw new Error(`Project namespace not found: ${projectRef}`);
    }

    namespace.environmentVariables = new Map(envVars);
    console.log(`Updated environment variables for project: ${projectRef}`);
  }

  /**
   * Get project namespace by reference
   * @param projectRef - Project reference
   * @returns ProjectNamespace or undefined if not found
   */
  getProjectNamespace(projectRef: string): ProjectNamespace | undefined {
    return this.namespaces.get(projectRef);
  }

  /**
   * Get all project namespaces
   * @returns Map of all project namespaces
   */
  getAllNamespaces(): Map<string, ProjectNamespace> {
    return new Map(this.namespaces);
  }

  /**
   * Remove a project namespace and all its functions
   * @param projectRef - Project reference to remove
   * @returns True if namespace was removed, false if it didn't exist
   */
  removeProjectNamespace(projectRef: string): boolean {
    const namespace = this.namespaces.get(projectRef);
    if (!namespace) {
      return false;
    }

    // Remove all function mappings for this project
    for (const [functionId, project] of this.functionToProject.entries()) {
      if (project === projectRef || functionId.startsWith(`${projectRef}:`)) {
        this.functionToProject.delete(functionId);
      }
    }

    // Remove the namespace
    this.namespaces.delete(projectRef);
    
    console.log(`Removed project namespace: ${projectRef}`);
    return true;
  }

  /**
   * Get function instance by ID within a project
   * @param functionId - Function identifier
   * @param projectRef - Project reference
   * @returns FunctionInstance or undefined if not found
   */
  getFunctionInstance(functionId: string, projectRef: string): FunctionInstance | undefined {
    if (!this.validateProjectAccess(functionId, projectRef)) {
      return undefined;
    }

    const namespace = this.namespaces.get(projectRef);
    if (!namespace) {
      return undefined;
    }

    return namespace.functions.get(functionId);
  }

  /**
   * List all functions in a project namespace
   * @param projectRef - Project reference
   * @returns Array of function instances
   */
  listProjectFunctions(projectRef: string): FunctionInstance[] {
    const namespace = this.namespaces.get(projectRef);
    if (!namespace) {
      return [];
    }

    // Return unique functions (avoid duplicates from different keys)
    const uniqueFunctions = new Map<string, FunctionInstance>();
    for (const func of namespace.functions.values()) {
      uniqueFunctions.set(func.id, func);
    }

    return Array.from(uniqueFunctions.values());
  }

  /**
   * Validate namespace manager state
   * @returns Validation result with any issues found
   */
  validate(): { isValid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate each namespace
    for (const [projectRef, namespace] of this.namespaces.entries()) {
      if (!projectRef) {
        errors.push('Found namespace with empty project reference');
        continue;
      }

      if (namespace.projectRef !== projectRef) {
        errors.push(`Namespace project reference mismatch: ${projectRef} vs ${namespace.projectRef}`);
      }

      // Validate functions in namespace
      for (const [functionId, functionInstance] of namespace.functions.entries()) {
        if (functionInstance.projectRef !== projectRef) {
          errors.push(`Function ${functionId} has incorrect project reference: ${functionInstance.projectRef} vs ${projectRef}`);
        }

        // Check if function is properly tracked
        const trackedProject = this.functionToProject.get(functionId);
        if (trackedProject !== projectRef) {
          warnings.push(`Function ${functionId} tracking mismatch: ${trackedProject} vs ${projectRef}`);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}