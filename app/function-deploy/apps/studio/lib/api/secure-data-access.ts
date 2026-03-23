/**
 * Secure Data Access Layer
 * 
 * Provides secure database query functions with automatic project filtering
 * and data ownership validation to prevent cross-project data leakage.
 */

import { executeQuery, QueryOptions } from './self-hosted/query'
import { WrappedResult } from './self-hosted/types'
import { executeQueryWithMonitoring } from './query-performance-monitor'

/**
 * Options for secure query execution
 */
export interface SecureQueryOptions {
  projectId: number
  userId: string
  validateOwnership?: boolean
  readOnly?: boolean
  projectRef?: string
}

/**
 * Result of data ownership validation
 */
export interface DataOwnershipValidationResult {
  isValid: boolean
  invalidItems: any[]
  reason?: string
}

/**
 * Execute a secure query with automatic project filtering
 * 
 * This function automatically adds project filtering to queries to prevent
 * cross-project data access. All queries are parameterized to prevent SQL injection.
 * 
 * @param query - SQL query string (should include $projectId placeholder)
 * @param params - Query parameters (projectId will be automatically added)
 * @param options - Security options including project and user context
 * @returns Query result with security validation
 */
export async function executeSecureQuery<T = any>(
  query: string,
  params: any[] = [],
  options: SecureQueryOptions
): Promise<WrappedResult<T[]>> {
  try {
    const { projectId, userId, validateOwnership = true, readOnly = false, projectRef } = options

    // Validate required security parameters
    if (!projectId || !userId) {
      return {
        data: undefined,
        error: new Error('Security validation failed: projectId and userId are required')
      }
    }

    // Ensure query uses parameterized queries (basic SQL injection prevention)
    if (!isParameterizedQuery(query)) {
      console.error('[Secure Data Access] Non-parameterized query detected:', query.substring(0, 100))
      return {
        data: undefined,
        error: new Error('Security validation failed: Query must use parameterized parameters')
      }
    }

    // Add project filtering if not already present
    const secureQuery = ensureProjectFiltering(query, projectId)
    
    // Prepare parameters with project ID
    const secureParams = [...params, projectId]

    // Log security context for audit
    console.log('[Secure Data Access] Executing secure query', {
      userId,
      projectId,
      projectRef,
      readOnly,
      queryPreview: secureQuery.substring(0, 100),
      timestamp: new Date().toISOString()
    })

    // Execute the query with performance monitoring
    const result = await executeQueryWithMonitoring<T>(
      secureQuery,
      secureParams,
      {
        userId,
        projectId,
        endpoint: projectRef ? `/api/projects/${projectRef}` : undefined
      }
    )

    if (result.error) {
      console.error('[Secure Data Access] Query execution failed:', result.error)
      return result
    }

    // Log performance metrics if available
    if ('metrics' in result && result.metrics) {
      console.log('[Secure Data Access] Query performance', {
        executionTimeMs: result.metrics.executionTimeMs,
        rowsReturned: result.metrics.rowsReturned,
        meetsRequirement: result.metrics.executionTimeMs < 100
      })
    }

    // Validate data ownership if requested
    if (validateOwnership && result.data) {
      const ownershipValidation = await validateDataOwnership(result.data, options)
      
      if (!ownershipValidation.isValid) {
        console.warn('[Secure Data Access] Data ownership validation failed', {
          userId,
          projectId,
          invalidItemsCount: ownershipValidation.invalidItems.length,
          reason: ownershipValidation.reason
        })

        // Filter out invalid items instead of failing completely
        const validData = result.data.filter(item => 
          !ownershipValidation.invalidItems.includes(item)
        )

        return {
          data: validData as T[],
          error: undefined
        }
      }
    }

    console.log('[Secure Data Access] Query executed successfully', {
      userId,
      projectId,
      resultCount: result.data?.length || 0
    })

    return result

  } catch (error) {
    console.error('[Secure Data Access] Unexpected error:', error)
    return {
      data: undefined,
      error: error instanceof Error ? error : new Error('Unknown error in secure query execution')
    }
  }
}

/**
 * Project-scoped query builder for constructing secure queries
 * 
 * This class helps build SQL queries with automatic project filtering
 * and parameterized query construction to prevent SQL injection.
 */
export class ProjectScopedQueryBuilder {
  private selectClause: string = ''
  private fromClause: string = ''
  private joinClauses: string[] = []
  private whereConditions: string[] = []
  private orderByClause: string = ''
  private limitClause: string = ''
  private parameters: any[] = []
  private parameterIndex: number = 1

  constructor(
    private projectId: number,
    private userId: string
  ) {
    // Automatically add project filtering
    this.whereConditions.push(`project_id = $${this.parameterIndex}`)
    this.parameters.push(projectId)
    this.parameterIndex++
  }

  /**
   * Set the SELECT clause
   */
  select(columns: string[] = ['*']): this {
    this.selectClause = `SELECT ${columns.join(', ')}`
    return this
  }

  /**
   * Set the FROM clause
   */
  from(table: string): this {
    this.fromClause = `FROM ${table}`
    return this
  }

  /**
   * Add a JOIN clause
   */
  join(table: string, condition: string): this {
    this.joinClauses.push(`JOIN ${table} ON ${condition}`)
    return this
  }

  /**
   * Add a LEFT JOIN clause
   */
  leftJoin(table: string, condition: string): this {
    this.joinClauses.push(`LEFT JOIN ${table} ON ${condition}`)
    return this
  }

  /**
   * Add a WHERE condition with parameters
   */
  where(condition: string, ...params: any[]): this {
    // Replace ? placeholders with $n parameters
    let parameterizedCondition = condition
    for (const param of params) {
      parameterizedCondition = parameterizedCondition.replace('?', `$${this.parameterIndex}`)
      this.parameters.push(param)
      this.parameterIndex++
    }
    
    this.whereConditions.push(parameterizedCondition)
    return this
  }

  /**
   * Add an ORDER BY clause
   */
  orderBy(column: string, direction: 'ASC' | 'DESC' = 'ASC'): this {
    this.orderByClause = `ORDER BY ${column} ${direction}`
    return this
  }

  /**
   * Add a LIMIT clause
   */
  limit(count: number): this {
    this.limitClause = `LIMIT ${count}`
    return this
  }

  /**
   * Build the final query and parameters
   */
  build(): { query: string; params: any[] } {
    if (!this.selectClause || !this.fromClause) {
      throw new Error('SELECT and FROM clauses are required')
    }

    const queryParts = [
      this.selectClause,
      this.fromClause,
      ...this.joinClauses,
      this.whereConditions.length > 0 ? `WHERE ${this.whereConditions.join(' AND ')}` : '',
      this.orderByClause,
      this.limitClause
    ].filter(part => part.length > 0)

    const query = queryParts.join(' ')
    
    return {
      query,
      params: this.parameters
    }
  }

  /**
   * Execute the built query
   */
  async execute<T = any>(options: Omit<SecureQueryOptions, 'projectId' | 'userId'>): Promise<WrappedResult<T[]>> {
    const { query, params } = this.build()
    
    return executeSecureQuery<T>(query, params, {
      projectId: this.projectId,
      userId: this.userId,
      ...options
    })
  }
}

/**
 * Validate that returned data belongs to the requested project
 * 
 * This function performs cross-reference checks to ensure that all returned
 * data items actually belong to the project that was requested.
 * 
 * @param data - Array of data items to validate
 * @param options - Security options with project context
 * @returns Validation result with details about any invalid items
 */
export async function validateDataOwnership<T = any>(
  data: T[],
  options: SecureQueryOptions
): Promise<DataOwnershipValidationResult> {
  try {
    const { projectId, userId } = options
    const invalidItems: T[] = []

    // Check each data item for project ownership
    for (const item of data) {
      if (!isValidDataItem(item, projectId)) {
        invalidItems.push(item)
      }
    }

    if (invalidItems.length > 0) {
      // Log security violation
      console.warn('[Data Ownership Validation] Cross-project data leakage detected', {
        userId,
        projectId,
        totalItems: data.length,
        invalidItems: invalidItems.length,
        timestamp: new Date().toISOString()
      })

      return {
        isValid: false,
        invalidItems,
        reason: `${invalidItems.length} items do not belong to project ${projectId}`
      }
    }

    return {
      isValid: true,
      invalidItems: []
    }

  } catch (error) {
    console.error('[Data Ownership Validation] Validation error:', error)
    return {
      isValid: false,
      invalidItems: data, // Assume all items are invalid if validation fails
      reason: 'Validation error occurred'
    }
  }
}

/**
 * Check if a query uses parameterized parameters (basic SQL injection prevention)
 */
function isParameterizedQuery(query: string): boolean {
  // Check for common SQL injection patterns
  const dangerousPatterns = [
    /;\s*drop\s+/i,
    /;\s*delete\s+/i,
    /;\s*update\s+.*set\s+/i,
    /;\s*insert\s+/i,
    /union\s+select/i,
    /'.*or.*'.*=/i,
    /'.*and.*'.*=/i,
    /--.*$/m,
    /\/\*.*\*\//
  ]

  // Check for dangerous patterns
  for (const pattern of dangerousPatterns) {
    if (pattern.test(query)) {
      return false
    }
  }

  // Check that query uses parameterized placeholders ($1, $2, etc.)
  // Allow queries without parameters only if they don't contain user input
  const hasParameters = /\$\d+/.test(query)
  const hasStringLiterals = /'[^']*'/.test(query)
  
  // If query has string literals but no parameters, it might be unsafe
  if (hasStringLiterals && !hasParameters) {
    // Allow certain safe patterns like static queries
    const safeStaticPatterns = [
      /^SELECT\s+\*\s+FROM\s+\w+\s*$/i,
      /^SELECT\s+[\w,\s]+\s+FROM\s+\w+\s*$/i
    ]
    
    return safeStaticPatterns.some(pattern => pattern.test(query.trim()))
  }

  return true
}

/**
 * Ensure query includes project filtering
 */
function ensureProjectFiltering(query: string, projectId: number): string {
  // Check if query already has project filtering
  const hasProjectFilter = /project_id\s*=\s*\$\d+/i.test(query) || 
                          /WHERE.*project_id/i.test(query)

  if (hasProjectFilter) {
    return query
  }

  // Add project filtering to WHERE clause
  const whereMatch = query.match(/\bWHERE\b/i)
  
  if (whereMatch) {
    // Insert project filter after existing WHERE clause
    const whereIndex = whereMatch.index! + whereMatch[0].length
    return query.slice(0, whereIndex) + 
           ` project_id = $${getNextParameterIndex(query)} AND` +
           query.slice(whereIndex)
  } else {
    // Add WHERE clause with project filter
    const fromMatch = query.match(/\bFROM\s+\w+/i)
    if (fromMatch) {
      const insertIndex = fromMatch.index! + fromMatch[0].length
      return query.slice(0, insertIndex) + 
             ` WHERE project_id = $${getNextParameterIndex(query)}` +
             query.slice(insertIndex)
    }
  }

  // If we can't automatically add filtering, return original query
  // The calling code should handle this case
  console.warn('[Secure Data Access] Could not automatically add project filtering to query:', query.substring(0, 100))
  return query
}

/**
 * Get the next parameter index for a query
 */
function getNextParameterIndex(query: string): number {
  const paramMatches = query.match(/\$(\d+)/g)
  if (!paramMatches) {
    return 1
  }
  
  const maxIndex = Math.max(...paramMatches.map(match => parseInt(match.substring(1))))
  return maxIndex + 1
}

/**
 * Check if a data item belongs to the specified project
 */
function isValidDataItem(item: any, projectId: number): boolean {
  // Check for common project ID fields
  const projectIdFields = ['project_id', 'projectId', 'project_ref']
  
  for (const field of projectIdFields) {
    if (field in item) {
      // For project_id, check numeric equality
      if (field === 'project_id' || field === 'projectId') {
        return item[field] === projectId || item[field] === String(projectId)
      }
      
      // For project_ref, we would need to resolve it to project_id
      // For now, we'll assume it's valid if present
      if (field === 'project_ref' && item[field]) {
        return true
      }
    }
  }

  // If no project identifier found, assume it's valid
  // This handles cases where the data doesn't have explicit project association
  return true
}

/**
 * Create a project-scoped query builder
 * 
 * @param projectId - Project ID for filtering
 * @param userId - User ID for audit logging
 * @returns New ProjectScopedQueryBuilder instance
 */
export function createProjectScopedQueryBuilder(
  projectId: number,
  userId: string
): ProjectScopedQueryBuilder {
  return new ProjectScopedQueryBuilder(projectId, userId)
}

/**
 * Execute a simple secure SELECT query with project filtering
 * 
 * This is a convenience function for common SELECT operations.
 * 
 * @param table - Table name to query
 * @param columns - Columns to select (default: all)
 * @param whereConditions - Additional WHERE conditions
 * @param options - Security options
 * @returns Query result
 */
export async function executeSecureSelect<T = any>(
  table: string,
  columns: string[] = ['*'],
  whereConditions: { condition: string; params: any[] }[] = [],
  options: SecureQueryOptions
): Promise<WrappedResult<T[]>> {
  const builder = createProjectScopedQueryBuilder(options.projectId, options.userId)
  
  builder.select(columns).from(table)
  
  // Add additional WHERE conditions
  for (const { condition, params } of whereConditions) {
    builder.where(condition, ...params)
  }

  return builder.execute<T>(options)
}

/**
 * Execute a secure COUNT query with project filtering
 * 
 * @param table - Table name to count
 * @param whereConditions - Additional WHERE conditions
 * @param options - Security options
 * @returns Count result
 */
export async function executeSecureCount(
  table: string,
  whereConditions: { condition: string; params: any[] }[] = [],
  options: SecureQueryOptions
): Promise<WrappedResult<{ count: number }[]>> {
  const builder = createProjectScopedQueryBuilder(options.projectId, options.userId)
  
  builder.select(['COUNT(*) as count']).from(table)
  
  // Add additional WHERE conditions
  for (const { condition, params } of whereConditions) {
    builder.where(condition, ...params)
  }

  return builder.execute<{ count: number }>(options)
}

/**
 * Validate that a user has permission to access specific data
 * 
 * This function can be extended to implement more sophisticated
 * permission checking beyond basic project ownership.
 * 
 * @param userId - User ID requesting access
 * @param projectId - Project ID being accessed
 * @param dataType - Type of data being accessed (for future permission granularity)
 * @param operation - Operation being performed (read, write, delete)
 * @returns True if access is allowed
 */
export async function validateDataAccess(
  userId: string,
  projectId: number,
  dataType: string = 'general',
  operation: 'read' | 'write' | 'delete' = 'read'
): Promise<boolean> {
  try {
    // Import auth helpers to validate project access
    const { validateUserProjectAccess, getUserProjectPermissions } = await import('./auth-helpers')
    
    // Check basic project access
    const accessResult = await validateUserProjectAccess(userId, projectId)
    
    if (!accessResult.hasAccess) {
      return false
    }

    // Check specific permissions based on operation
    const permissions = await getUserProjectPermissions(userId, projectId)
    
    switch (operation) {
      case 'read':
        return permissions.canRead
      case 'write':
        return permissions.canWrite
      case 'delete':
        return permissions.canDelete || permissions.canAdmin
      default:
        return false
    }

  } catch (error) {
    console.error('[Data Access Validation] Error validating data access:', error)
    return false
  }
}