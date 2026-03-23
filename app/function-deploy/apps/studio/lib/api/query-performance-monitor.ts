/**
 * Query Performance Monitoring and Optimization
 * 
 * This module provides tools for monitoring and optimizing database query performance
 * for the user project isolation feature. It tracks query execution times, validates
 * index usage, and provides performance metrics.
 * 
 * Requirements: 8.4, 8.5
 */

import { executeQuery } from './self-hosted/query'
import { WrappedResult } from './self-hosted/types'

/**
 * Query performance metrics
 */
export interface QueryPerformanceMetrics {
  queryId: string
  query: string
  executionTimeMs: number
  rowsReturned: number
  indexesUsed: string[]
  sequentialScans: number
  timestamp: string
  userId?: string
  projectId?: number
  endpoint?: string
}

/**
 * Index usage statistics
 */
export interface IndexUsageStats {
  tableName: string
  indexName: string
  indexScans: number
  tuplesRead: number
  tuplesReturned: number
  indexSize: string
  lastUsed?: string
}

/**
 * Query execution plan node
 */
export interface QueryPlanNode {
  nodeType: string
  relationName?: string
  indexName?: string
  startupCost: number
  totalCost: number
  planRows: number
  planWidth: number
  actualTime?: number
  actualRows?: number
  plans?: QueryPlanNode[]
}

/**
 * Performance threshold configuration
 */
export interface PerformanceThresholds {
  slowQueryMs: number // Queries slower than this are logged as slow
  criticalQueryMs: number // Queries slower than this trigger alerts
  maxSequentialScans: number // Maximum acceptable sequential scans
}

/**
 * Default performance thresholds
 */
const DEFAULT_THRESHOLDS: PerformanceThresholds = {
  slowQueryMs: 100, // 100ms as per requirement 8.1
  criticalQueryMs: 500,
  maxSequentialScans: 1
}

/**
 * In-memory performance metrics store
 * In production, this should be replaced with a persistent store (Redis, TimescaleDB, etc.)
 */
class PerformanceMetricsStore {
  private metrics: QueryPerformanceMetrics[] = []
  private maxMetrics: number = 1000 // Keep last 1000 metrics

  add(metric: QueryPerformanceMetrics): void {
    this.metrics.push(metric)
    
    // Keep only the most recent metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics)
    }
  }

  getRecent(count: number = 100): QueryPerformanceMetrics[] {
    return this.metrics.slice(-count)
  }

  getSlowQueries(thresholdMs: number = DEFAULT_THRESHOLDS.slowQueryMs): QueryPerformanceMetrics[] {
    return this.metrics.filter(m => m.executionTimeMs > thresholdMs)
  }

  getByEndpoint(endpoint: string): QueryPerformanceMetrics[] {
    return this.metrics.filter(m => m.endpoint === endpoint)
  }

  getByProject(projectId: number): QueryPerformanceMetrics[] {
    return this.metrics.filter(m => m.projectId === projectId)
  }

  getAverageExecutionTime(): number {
    if (this.metrics.length === 0) return 0
    const sum = this.metrics.reduce((acc, m) => acc + m.executionTimeMs, 0)
    return sum / this.metrics.length
  }

  getP95ExecutionTime(): number {
    if (this.metrics.length === 0) return 0
    const sorted = [...this.metrics].sort((a, b) => a.executionTimeMs - b.executionTimeMs)
    const p95Index = Math.floor(sorted.length * 0.95)
    return sorted[p95Index]?.executionTimeMs || 0
  }

  clear(): void {
    this.metrics = []
  }
}

// Singleton instance
let metricsStore: PerformanceMetricsStore | null = null

function getMetricsStore(): PerformanceMetricsStore {
  if (!metricsStore) {
    metricsStore = new PerformanceMetricsStore()
  }
  return metricsStore
}

/**
 * Execute a query with performance monitoring
 * 
 * @param query - SQL query to execute
 * @param parameters - Query parameters
 * @param context - Execution context for logging
 * @returns Query result with performance metrics
 */
export async function executeQueryWithMonitoring<T = any>(
  query: string,
  parameters: any[] = [],
  context: {
    userId?: string
    projectId?: number
    endpoint?: string
  } = {}
): Promise<WrappedResult<T[]> & { metrics?: QueryPerformanceMetrics }> {
  const queryId = generateQueryId()
  const startTime = Date.now()

  try {
    // Execute the query
    const result = await executeQuery<T>({
      query,
      parameters,
      projectRef: context.projectId?.toString()
    })

    const executionTimeMs = Date.now() - startTime

    // Create performance metrics
    const metrics: QueryPerformanceMetrics = {
      queryId,
      query: sanitizeQueryForLogging(query),
      executionTimeMs,
      rowsReturned: result.data?.length || 0,
      indexesUsed: [], // Will be populated by EXPLAIN analysis
      sequentialScans: 0, // Will be populated by EXPLAIN analysis
      timestamp: new Date().toISOString(),
      ...context
    }

    // Store metrics
    getMetricsStore().add(metrics)

    // Log slow queries
    if (executionTimeMs > DEFAULT_THRESHOLDS.slowQueryMs) {
      console.warn('[Query Performance] Slow query detected', {
        queryId,
        executionTimeMs,
        threshold: DEFAULT_THRESHOLDS.slowQueryMs,
        query: metrics.query.substring(0, 200),
        ...context
      })
    }

    // Log critical queries
    if (executionTimeMs > DEFAULT_THRESHOLDS.criticalQueryMs) {
      console.error('[Query Performance] Critical slow query detected', {
        queryId,
        executionTimeMs,
        threshold: DEFAULT_THRESHOLDS.criticalQueryMs,
        query: metrics.query.substring(0, 200),
        ...context
      })
    }

    return {
      ...result,
      metrics
    }

  } catch (error) {
    const executionTimeMs = Date.now() - startTime
    
    console.error('[Query Performance] Query execution failed', {
      queryId,
      executionTimeMs,
      error: error instanceof Error ? error.message : 'Unknown error',
      query: sanitizeQueryForLogging(query).substring(0, 200),
      ...context
    })

    throw error
  }
}

/**
 * Analyze query execution plan to identify optimization opportunities
 * 
 * @param query - SQL query to analyze
 * @param parameters - Query parameters
 * @returns Query execution plan analysis
 */
export async function analyzeQueryPlan(
  query: string,
  parameters: any[] = []
): Promise<WrappedResult<{
  plan: QueryPlanNode
  usesIndexes: boolean
  hasSequentialScans: boolean
  estimatedCost: number
  recommendations: string[]
}>> {
  try {
    // Execute EXPLAIN (FORMAT JSON) to get query plan
    const explainQuery = `EXPLAIN (FORMAT JSON, ANALYZE false) ${query}`
    
    const result = await executeQuery<any>({
      query: explainQuery,
      parameters
    })

    if (result.error || !result.data || result.data.length === 0) {
      return {
        data: undefined,
        error: new Error('Failed to analyze query plan')
      }
    }

    // Parse the execution plan
    const planData = result.data[0]['QUERY PLAN']
    const plan: QueryPlanNode = planData[0].Plan

    // Analyze the plan
    const analysis = {
      plan,
      usesIndexes: checkIndexUsage(plan),
      hasSequentialScans: checkSequentialScans(plan),
      estimatedCost: plan.totalCost,
      recommendations: generateRecommendations(plan, query)
    }

    return {
      data: analysis,
      error: undefined
    }

  } catch (error) {
    console.error('[Query Performance] Failed to analyze query plan:', error)
    return {
      data: undefined,
      error: error instanceof Error ? error : new Error('Unknown error analyzing query plan')
    }
  }
}

/**
 * Check if query plan uses indexes
 */
function checkIndexUsage(plan: QueryPlanNode): boolean {
  if (plan.nodeType === 'Index Scan' || plan.nodeType === 'Index Only Scan' || plan.nodeType === 'Bitmap Index Scan') {
    return true
  }

  if (plan.plans) {
    return plan.plans.some(checkIndexUsage)
  }

  return false
}

/**
 * Check if query plan has sequential scans
 */
function checkSequentialScans(plan: QueryPlanNode): boolean {
  if (plan.nodeType === 'Seq Scan') {
    return true
  }

  if (plan.plans) {
    return plan.plans.some(checkSequentialScans)
  }

  return false
}

/**
 * Generate optimization recommendations based on query plan
 */
function generateRecommendations(plan: QueryPlanNode, query: string): string[] {
  const recommendations: string[] = []

  // Check for sequential scans
  if (checkSequentialScans(plan)) {
    recommendations.push('Query uses sequential scan. Consider adding an index on the filtered columns.')
  }

  // Check for high cost
  if (plan.totalCost > 1000) {
    recommendations.push('Query has high estimated cost. Consider optimizing the query or adding indexes.')
  }

  // Check for missing project_id filter
  if (!query.toLowerCase().includes('project_id')) {
    recommendations.push('Query does not filter by project_id. Ensure project isolation is applied.')
  }

  // Check for SELECT *
  if (query.toLowerCase().includes('select *')) {
    recommendations.push('Query uses SELECT *. Consider selecting only required columns for better performance.')
  }

  return recommendations
}

/**
 * Verify that studio_projects table has proper indexes
 * 
 * @returns Index verification result
 */
export async function verifyStudioProjectsIndexes(): Promise<WrappedResult<{
  hasOwnerIndex: boolean
  hasOrgIndex: boolean
  hasRefIndex: boolean
  missingIndexes: string[]
  recommendations: string[]
}>> {
  try {
    // Query pg_indexes to check for required indexes
    const result = await executeQuery<{
      indexname: string
      indexdef: string
    }>({
      query: `
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'studio_projects'
        AND schemaname = '_studio'
      `
    })

    if (result.error) {
      return {
        data: undefined,
        error: result.error
      }
    }

    const indexes = result.data || []
    
    // Check for required indexes
    const hasOwnerIndex = indexes.some(idx => 
      idx.indexname.includes('owner') || idx.indexdef.toLowerCase().includes('owner_user_id')
    )
    
    const hasOrgIndex = indexes.some(idx => 
      idx.indexname.includes('org') || idx.indexdef.toLowerCase().includes('organization_id')
    )
    
    const hasRefIndex = indexes.some(idx => 
      idx.indexname.includes('ref') || idx.indexdef.toLowerCase().includes(' ref')
    )

    // Identify missing indexes
    const missingIndexes: string[] = []
    if (!hasOwnerIndex) missingIndexes.push('idx_studio_projects_owner (owner_user_id)')
    if (!hasOrgIndex) missingIndexes.push('idx_studio_projects_org (organization_id)')
    if (!hasRefIndex) missingIndexes.push('idx_studio_projects_ref (ref)')

    // Generate recommendations
    const recommendations: string[] = []
    if (missingIndexes.length > 0) {
      recommendations.push(`Create missing indexes: ${missingIndexes.join(', ')}`)
      recommendations.push('Run: CREATE INDEX idx_studio_projects_owner ON _studio.studio_projects(owner_user_id);')
      recommendations.push('Run: CREATE INDEX idx_studio_projects_org ON _studio.studio_projects(organization_id);')
      recommendations.push('Run: CREATE INDEX idx_studio_projects_ref ON _studio.studio_projects(ref);')
    } else {
      recommendations.push('All required indexes are present.')
    }

    return {
      data: {
        hasOwnerIndex,
        hasOrgIndex,
        hasRefIndex,
        missingIndexes,
        recommendations
      },
      error: undefined
    }

  } catch (error) {
    console.error('[Query Performance] Failed to verify indexes:', error)
    return {
      data: undefined,
      error: error instanceof Error ? error : new Error('Unknown error verifying indexes')
    }
  }
}

/**
 * Get index usage statistics for studio_projects table
 * 
 * @returns Index usage statistics
 */
export async function getIndexUsageStats(): Promise<WrappedResult<IndexUsageStats[]>> {
  try {
    const result = await executeQuery<IndexUsageStats>({
      query: `
        SELECT
          schemaname || '.' || tablename as table_name,
          indexname as index_name,
          idx_scan as index_scans,
          idx_tup_read as tuples_read,
          idx_tup_fetch as tuples_returned,
          pg_size_pretty(pg_relation_size(indexrelid)) as index_size
        FROM pg_stat_user_indexes
        WHERE schemaname = '_studio'
        AND tablename = 'studio_projects'
        ORDER BY idx_scan DESC
      `
    })

    if (result.error) {
      return {
        data: undefined,
        error: result.error
      }
    }

    return {
      data: result.data || [],
      error: undefined
    }

  } catch (error) {
    console.error('[Query Performance] Failed to get index usage stats:', error)
    return {
      data: undefined,
      error: error instanceof Error ? error : new Error('Unknown error getting index usage stats')
    }
  }
}

/**
 * Optimize a query by analyzing its execution plan and suggesting improvements
 * 
 * @param query - SQL query to optimize
 * @param parameters - Query parameters
 * @returns Optimization suggestions
 */
export async function optimizeQuery(
  query: string,
  parameters: any[] = []
): Promise<WrappedResult<{
  originalQuery: string
  optimizedQuery?: string
  recommendations: string[]
  estimatedImprovement?: string
}>> {
  try {
    // Analyze the original query
    const planResult = await analyzeQueryPlan(query, parameters)
    
    if (planResult.error || !planResult.data) {
      return {
        data: undefined,
        error: planResult.error || new Error('Failed to analyze query')
      }
    }

    const { plan, usesIndexes, hasSequentialScans, recommendations } = planResult.data

    // Generate optimization suggestions
    const allRecommendations = [...recommendations]

    // Check if query can be optimized
    let optimizedQuery: string | undefined
    let estimatedImprovement: string | undefined

    if (hasSequentialScans && !usesIndexes) {
      allRecommendations.push('Consider adding indexes to avoid sequential scans')
      estimatedImprovement = 'Could improve performance by 10-100x with proper indexes'
    }

    if (!query.toLowerCase().includes('limit')) {
      allRecommendations.push('Consider adding LIMIT clause to reduce result set size')
      optimizedQuery = `${query} LIMIT 100`
      estimatedImprovement = 'Limiting results can significantly improve response time'
    }

    return {
      data: {
        originalQuery: query,
        optimizedQuery,
        recommendations: allRecommendations,
        estimatedImprovement
      },
      error: undefined
    }

  } catch (error) {
    console.error('[Query Performance] Failed to optimize query:', error)
    return {
      data: undefined,
      error: error instanceof Error ? error : new Error('Unknown error optimizing query')
    }
  }
}

/**
 * Get performance metrics summary
 * 
 * @returns Performance metrics summary
 */
export function getPerformanceMetricsSummary(): {
  totalQueries: number
  averageExecutionTimeMs: number
  p95ExecutionTimeMs: number
  slowQueriesCount: number
  criticalQueriesCount: number
  recentQueries: QueryPerformanceMetrics[]
} {
  const store = getMetricsStore()
  const recentQueries = store.getRecent(10)
  const slowQueries = store.getSlowQueries(DEFAULT_THRESHOLDS.slowQueryMs)
  const criticalQueries = store.getSlowQueries(DEFAULT_THRESHOLDS.criticalQueryMs)

  return {
    totalQueries: store.getRecent(1000).length,
    averageExecutionTimeMs: store.getAverageExecutionTime(),
    p95ExecutionTimeMs: store.getP95ExecutionTime(),
    slowQueriesCount: slowQueries.length,
    criticalQueriesCount: criticalQueries.length,
    recentQueries
  }
}

/**
 * Clear performance metrics (useful for testing)
 */
export function clearPerformanceMetrics(): void {
  getMetricsStore().clear()
}

/**
 * Generate a unique query ID
 */
function generateQueryId(): string {
  return `q_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Sanitize query for logging (remove sensitive data)
 */
function sanitizeQueryForLogging(query: string): string {
  // Remove potential sensitive data from query
  return query
    .replace(/password\s*=\s*'[^']*'/gi, "password='***'")
    .replace(/token\s*=\s*'[^']*'/gi, "token='***'")
    .replace(/secret\s*=\s*'[^']*'/gi, "secret='***'")
}

/**
 * Monitor permission validation query performance
 * 
 * This function specifically monitors the performance of permission validation queries
 * to ensure they meet the < 100ms requirement.
 * 
 * @param userId - User ID
 * @param projectId - Project ID
 * @param operation - Operation being performed
 * @returns Performance metrics for the validation
 */
export async function monitorPermissionValidation(
  userId: string,
  projectId: number,
  operation: string
): Promise<{
  executionTimeMs: number
  meetsRequirement: boolean
  warning?: string
}> {
  const startTime = Date.now()

  try {
    // Import and execute the validation
    const { validateUserProjectAccess } = await import('./auth-helpers')
    await validateUserProjectAccess(userId, projectId)

    const executionTimeMs = Date.now() - startTime
    const meetsRequirement = executionTimeMs < DEFAULT_THRESHOLDS.slowQueryMs

    // Log if requirement is not met
    if (!meetsRequirement) {
      console.warn('[Permission Validation Performance] Validation exceeded threshold', {
        userId,
        projectId,
        operation,
        executionTimeMs,
        threshold: DEFAULT_THRESHOLDS.slowQueryMs
      })
    }

    return {
      executionTimeMs,
      meetsRequirement,
      warning: meetsRequirement ? undefined : `Validation took ${executionTimeMs}ms, exceeding ${DEFAULT_THRESHOLDS.slowQueryMs}ms threshold`
    }

  } catch (error) {
    const executionTimeMs = Date.now() - startTime
    
    console.error('[Permission Validation Performance] Validation failed', {
      userId,
      projectId,
      operation,
      executionTimeMs,
      error: error instanceof Error ? error.message : 'Unknown error'
    })

    throw error
  }
}
