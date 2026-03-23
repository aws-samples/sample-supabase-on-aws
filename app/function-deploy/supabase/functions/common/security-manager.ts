/**
 * Security Manager for Enhanced Edge Functions
 * 
 * Provides project-level security boundary enforcement, resource access validation,
 * and cross-project access denial mechanisms.
 * 
 * Requirements: 5.1, 5.2, 5.5
 */

import { ProjectCredentials, ProjectNamespace } from './namespace-manager.ts';
import { ApplicationError } from './errors.ts';

/**
 * Security violation types for logging and monitoring
 */
export enum SecurityViolationType {
  CROSS_PROJECT_ACCESS = 'cross_project_access',
  INVALID_RESOURCE_ACCESS = 'invalid_resource_access',
  UNAUTHORIZED_FUNCTION_CALL = 'unauthorized_function_call',
  NAMESPACE_BOUNDARY_VIOLATION = 'namespace_boundary_violation',
  CREDENTIAL_MISUSE = 'credential_misuse'
}

/**
 * Security violation record for logging
 */
export interface SecurityViolation {
  id: string;
  type: SecurityViolationType;
  sourceProjectRef: string;
  targetProjectRef?: string;
  resourceId?: string;
  functionId?: string;
  timestamp: Date;
  details: Record<string, any>;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Resource access request for validation
 */
export interface ResourceAccessRequest {
  functionId: string;
  projectRef: string;
  resourceType: 'database' | 'storage' | 'auth' | 'function' | 'api';
  resourceId: string;
  operation: 'read' | 'write' | 'execute' | 'delete';
  credentials?: ProjectCredentials;
}

/**
 * Security context for function execution
 */
export interface SecurityContext {
  projectRef: string;
  functionId: string;
  namespace: string;
  credentials: ProjectCredentials;
  permissions: Set<string>;
  isolationLevel: 'strict' | 'permissive';
}

/**
 * Security Manager interface for project boundary enforcement
 */
export interface SecurityManager {
  validateProjectAccess(functionId: string, projectRef: string): Promise<boolean>;
  validateResourceAccess(request: ResourceAccessRequest): Promise<boolean>;
  enforceProjectBoundaries(sourceProject: string, targetProject: string): Promise<boolean>;
  logSecurityViolation(violation: Omit<SecurityViolation, 'id' | 'timestamp'>): Promise<void>;
  createSecurityContext(functionId: string, projectRef: string): Promise<SecurityContext>;
  validateCrossProjectCall(sourceProject: string, targetProject: string, targetFunction: string): Promise<boolean>;
}

/**
 * Enhanced Security Manager implementation
 * Enforces project-level security boundaries and access control
 */
export class EnhancedSecurityManager implements SecurityManager {
  private violations: Map<string, SecurityViolation>;
  private securityContexts: Map<string, SecurityContext>;
  private projectPermissions: Map<string, Set<string>>;
  private violationCounter: number;

  constructor() {
    this.violations = new Map();
    this.securityContexts = new Map();
    this.projectPermissions = new Map();
    this.violationCounter = 0;
  }

  /**
   * Validate that a function has access to a specific project
   * Requirements: 5.1, 5.2
   */
  async validateProjectAccess(functionId: string, projectRef: string): Promise<boolean> {
    if (!functionId || typeof functionId !== 'string') {
      await this.logSecurityViolation({
        type: SecurityViolationType.INVALID_RESOURCE_ACCESS,
        sourceProjectRef: 'unknown',
        functionId,
        details: { reason: 'Invalid function ID provided' },
        severity: 'medium'
      });
      return false;
    }

    if (!projectRef || typeof projectRef !== 'string') {
      await this.logSecurityViolation({
        type: SecurityViolationType.INVALID_RESOURCE_ACCESS,
        sourceProjectRef: 'unknown',
        functionId,
        details: { reason: 'Invalid project reference provided' },
        severity: 'medium'
      });
      return false;
    }

    try {
      // Check if function belongs to the project namespace
      const functionProject = this.extractProjectFromFunctionId(functionId);
      
      if (functionProject !== projectRef) {
        await this.logSecurityViolation({
          type: SecurityViolationType.NAMESPACE_BOUNDARY_VIOLATION,
          sourceProjectRef: functionProject || 'unknown',
          targetProjectRef: projectRef,
          functionId,
          details: { 
            reason: 'Function does not belong to target project namespace',
            expectedProject: projectRef,
            actualProject: functionProject
          },
          severity: 'high'
        });
        return false;
      }

      // Validate project permissions
      const permissions = this.projectPermissions.get(projectRef);
      if (!permissions || !permissions.has('function_access')) {
        await this.logSecurityViolation({
          type: SecurityViolationType.UNAUTHORIZED_FUNCTION_CALL,
          sourceProjectRef: projectRef,
          functionId,
          details: { reason: 'Project lacks function access permissions' },
          severity: 'high'
        });
        return false;
      }

      return true;
    } catch (error) {
      await this.logSecurityViolation({
        type: SecurityViolationType.INVALID_RESOURCE_ACCESS,
        sourceProjectRef: projectRef,
        functionId,
        details: { 
          reason: 'Error during project access validation',
          error: error instanceof Error ? error.message : String(error)
        },
        severity: 'critical'
      });
      return false;
    }
  }

  /**
   * Validate resource access requests with project boundary enforcement
   * Requirements: 5.1, 5.2
   */
  async validateResourceAccess(request: ResourceAccessRequest): Promise<boolean> {
    const { functionId, projectRef, resourceType, resourceId, operation } = request;

    try {
      // First validate basic project access
      const hasProjectAccess = await this.validateProjectAccess(functionId, projectRef);
      if (!hasProjectAccess) {
        return false;
      }

      // Validate resource-specific permissions
      const resourcePermission = `${resourceType}_${operation}`;
      const projectPermissions = this.projectPermissions.get(projectRef);
      
      if (!projectPermissions || !projectPermissions.has(resourcePermission)) {
        await this.logSecurityViolation({
          type: SecurityViolationType.INVALID_RESOURCE_ACCESS,
          sourceProjectRef: projectRef,
          functionId,
          resourceId,
          details: { 
            reason: 'Insufficient permissions for resource access',
            resourceType,
            operation,
            requiredPermission: resourcePermission
          },
          severity: 'high'
        });
        return false;
      }

      // Validate resource belongs to the same project (prevent cross-project resource access)
      const resourceProject = this.extractProjectFromResourceId(resourceId);
      if (resourceProject && resourceProject !== projectRef) {
        await this.logSecurityViolation({
          type: SecurityViolationType.CROSS_PROJECT_ACCESS,
          sourceProjectRef: projectRef,
          targetProjectRef: resourceProject,
          functionId,
          resourceId,
          details: { 
            reason: 'Attempted cross-project resource access',
            resourceType,
            operation
          },
          severity: 'critical'
        });
        return false;
      }

      // Validate credentials if provided
      if (request.credentials) {
        const credentialsValid = await this.validateCredentials(request.credentials, projectRef);
        if (!credentialsValid) {
          await this.logSecurityViolation({
            type: SecurityViolationType.CREDENTIAL_MISUSE,
            sourceProjectRef: projectRef,
            functionId,
            resourceId,
            details: { 
              reason: 'Invalid or mismatched credentials provided',
              resourceType,
              operation
            },
            severity: 'critical'
          });
          return false;
        }
      }

      return true;
    } catch (error) {
      await this.logSecurityViolation({
        type: SecurityViolationType.INVALID_RESOURCE_ACCESS,
        sourceProjectRef: projectRef,
        functionId,
        resourceId,
        details: { 
          reason: 'Error during resource access validation',
          error: error instanceof Error ? error.message : String(error),
          resourceType,
          operation
        },
        severity: 'critical'
      });
      return false;
    }
  }

  /**
   * Enforce project boundaries between source and target projects
   * Requirements: 5.1, 5.5
   */
  async enforceProjectBoundaries(sourceProject: string, targetProject: string): Promise<boolean> {
    if (!sourceProject || !targetProject) {
      await this.logSecurityViolation({
        type: SecurityViolationType.NAMESPACE_BOUNDARY_VIOLATION,
        sourceProjectRef: sourceProject || 'unknown',
        targetProjectRef: targetProject || 'unknown',
        details: { reason: 'Invalid project references for boundary enforcement' },
        severity: 'medium'
      });
      return false;
    }

    // Same project access is always allowed
    if (sourceProject === targetProject) {
      return true;
    }

    // Cross-project access is denied by default (strict isolation)
    await this.logSecurityViolation({
      type: SecurityViolationType.CROSS_PROJECT_ACCESS,
      sourceProjectRef: sourceProject,
      targetProjectRef: targetProject,
      details: { 
        reason: 'Cross-project access denied by security policy',
        policy: 'strict_isolation'
      },
      severity: 'high'
    });

    return false;
  }

  /**
   * Log security violations for monitoring and audit
   * Requirements: 5.2, 5.5
   */
  async logSecurityViolation(violation: Omit<SecurityViolation, 'id' | 'timestamp'>): Promise<void> {
    const violationRecord: SecurityViolation = {
      ...violation,
      id: `violation_${++this.violationCounter}_${Date.now()}`,
      timestamp: new Date()
    };

    // Store violation for audit trail
    this.violations.set(violationRecord.id, violationRecord);

    // Log to console (in production, this would go to a proper logging system)
    const logLevel = this.getLogLevel(violation.severity);
    console[logLevel](`[SECURITY VIOLATION] ${violation.type}:`, {
      id: violationRecord.id,
      sourceProject: violation.sourceProjectRef,
      targetProject: violation.targetProjectRef,
      functionId: violation.functionId,
      resourceId: violation.resourceId,
      details: violation.details,
      timestamp: violationRecord.timestamp.toISOString()
    });

    // In a production environment, you would also:
    // 1. Send to security monitoring system
    // 2. Trigger alerts for critical violations
    // 3. Update security metrics
    // 4. Potentially block the source if too many violations
  }

  /**
   * Create security context for function execution
   * Requirements: 5.1, 5.2
   */
  async createSecurityContext(functionId: string, projectRef: string): Promise<SecurityContext> {
    const contextKey = `${projectRef}:${functionId}`;
    
    // Check if context already exists
    if (this.securityContexts.has(contextKey)) {
      return this.securityContexts.get(contextKey)!;
    }

    // Validate project access first
    const hasAccess = await this.validateProjectAccess(functionId, projectRef);
    if (!hasAccess) {
      throw new ApplicationError(`Access denied for function ${functionId} in project ${projectRef}`);
    }

    // Create new security context
    const context: SecurityContext = {
      projectRef,
      functionId,
      namespace: `proj_${projectRef}`,
      credentials: {
        serviceRoleKey: '', // Would be populated from secure storage
        anonKey: '',
        supabaseUrl: `https://${projectRef}.supabase.co`
      },
      permissions: this.projectPermissions.get(projectRef) || new Set(),
      isolationLevel: 'strict'
    };

    // Cache the context
    this.securityContexts.set(contextKey, context);
    
    return context;
  }

  /**
   * Validate cross-project function calls (should be denied)
   * Requirements: 5.5
   */
  async validateCrossProjectCall(
    sourceProject: string, 
    targetProject: string, 
    targetFunction: string
  ): Promise<boolean> {
    // Cross-project calls are not allowed in strict isolation mode
    const isAllowed = await this.enforceProjectBoundaries(sourceProject, targetProject);
    
    if (!isAllowed) {
      await this.logSecurityViolation({
        type: SecurityViolationType.CROSS_PROJECT_ACCESS,
        sourceProjectRef: sourceProject,
        targetProjectRef: targetProject,
        functionId: targetFunction,
        details: { 
          reason: 'Cross-project function call denied',
          targetFunction,
          policy: 'strict_isolation'
        },
        severity: 'high'
      });
    }

    return isAllowed;
  }

  /**
   * Set permissions for a project
   */
  setProjectPermissions(projectRef: string, permissions: Set<string>): void {
    this.projectPermissions.set(projectRef, new Set(permissions));
  }

  /**
   * Get all security violations for audit
   */
  getSecurityViolations(): SecurityViolation[] {
    return Array.from(this.violations.values());
  }

  /**
   * Get violations for a specific project
   */
  getProjectViolations(projectRef: string): SecurityViolation[] {
    return Array.from(this.violations.values()).filter(
      v => v.sourceProjectRef === projectRef || v.targetProjectRef === projectRef
    );
  }

  /**
   * Clear security context (useful for cleanup)
   */
  clearSecurityContext(functionId: string, projectRef: string): void {
    const contextKey = `${projectRef}:${functionId}`;
    this.securityContexts.delete(contextKey);
  }

  /**
   * Extract project reference from function ID
   */
  private extractProjectFromFunctionId(functionId: string): string | null {
    // Handle namespaced function IDs (e.g., "ef_project123_functionName")
    const namespacedMatch = functionId.match(/^ef_([^_]+)_/);
    if (namespacedMatch) {
      return namespacedMatch[1];
    }

    // Handle project-scoped function IDs (e.g., "project123:functionName")
    const scopedMatch = functionId.match(/^([^:]+):/);
    if (scopedMatch) {
      return scopedMatch[1];
    }

    // If no project can be extracted, return null
    return null;
  }

  /**
   * Extract project reference from resource ID
   */
  private extractProjectFromResourceId(resourceId: string): string | null {
    // Resource IDs might be prefixed with project reference
    // e.g., "project123_table_users" or "project123:bucket:images"
    const prefixMatch = resourceId.match(/^([^_:]+)[_:]/);
    if (prefixMatch) {
      return prefixMatch[1];
    }

    return null;
  }

  /**
   * Validate credentials against project
   */
  private async validateCredentials(credentials: ProjectCredentials, projectRef: string): Promise<boolean> {
    // Basic validation - in production this would verify against Supabase API
    if (!credentials.serviceRoleKey || !credentials.supabaseUrl) {
      return false;
    }

    // Check if URL matches project
    const expectedUrl = `https://${projectRef}.supabase.co`;
    if (credentials.supabaseUrl !== expectedUrl) {
      return false;
    }

    return true;
  }

  /**
   * Get appropriate log level for violation severity
   */
  private getLogLevel(severity: string): 'log' | 'warn' | 'error' {
    switch (severity) {
      case 'critical':
      case 'high':
        return 'error';
      case 'medium':
        return 'warn';
      default:
        return 'log';
    }
  }

  /**
   * Initialize default permissions for a project
   */
  initializeProjectPermissions(projectRef: string): void {
    const defaultPermissions = new Set([
      'function_access',
      'database_read',
      'database_write',
      'storage_read',
      'storage_write',
      'auth_read',
      'api_read',
      'api_write'
    ]);

    this.setProjectPermissions(projectRef, defaultPermissions);
  }

  /**
   * Validate security manager state
   */
  validate(): { isValid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate security contexts
    for (const [contextKey, context] of this.securityContexts.entries()) {
      if (!context.projectRef || !context.functionId) {
        errors.push(`Invalid security context: ${contextKey}`);
      }

      if (context.permissions.size === 0) {
        warnings.push(`Security context has no permissions: ${contextKey}`);
      }
    }

    // Validate project permissions
    for (const [projectRef, permissions] of this.projectPermissions.entries()) {
      if (!projectRef) {
        errors.push('Found project permissions with empty project reference');
      }

      if (permissions.size === 0) {
        warnings.push(`Project has no permissions: ${projectRef}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}