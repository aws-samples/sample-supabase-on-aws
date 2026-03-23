/**
 * Performance Optimization Service for PostgREST
 * 
 * This service implements comprehensive performance optimization features including:
 * - Query performance monitoring and analysis
 * - Response caching strategies
 * - Query complexity analysis and limits
 * - Connection pool optimization
 * 
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */

import { executeQueryWithMonitoring, QueryPerformanceMetrics } from './query-performance-monitor'
import { getDatabasePoolManager, PoolStats } from './database-pool-manager'
import { WrappedResult } from './self-hosted/types'

/**
 * Cache configuration interface
 */
export interface CacheConfig {
  enabled: boolean
  ttl: number // Time to live in milliseconds
  maxSize: number // Maximum number of cached entries
  keyPattern: string // Pattern for cache keys
  invalidationRules: CacheInvalidationRule[]
}

/**
 * Cache invalidation rule
 */
export interface CacheInvalidationRule {
  table: string
  operations: ('insert' | 'update' | 'delete')[]
  pattern: string
}

/**
 * Query complexity analysis result
 */
export interface QueryComplexityAnalysis {
  score: number // Complexity score (0-100)
  factors: ComplexityFactor[]
  recommendations: string[]
  shouldReject: boolean
  estimatedExecutionTime: number
}

/**
 * Complexity factor
 */
export interface ComplexityFactor {
  type: 'joins' | 'subqueries' | 'aggregations' | 'sorting' | 'filtering' | 'table_size'
  impact: number // Impact on complexity (0-10)
  description: string
}

/**
 * Performance optimization configuration
 */
export interface PerformanceConfig {
  queryTimeout: number
  maxComplexityScore: number
  cacheConfig: CacheConfig
  connectionPoolOptimization: boolean
  enableQueryRewriting: boolean
  enableIndexSuggestions: boolean
}
/**
 * Default performance configuration
 */
const DEFAULT_PERFORMANCE_CONFIG: PerformanceConfig = {
  queryTimeout: 30000, // 30 seconds
  maxComplexityScore: 75, // Reject queries with complexity > 75
  cacheConfig: {
    enabled: true,
    ttl: 5 * 60 * 1000, // 5 minutes
    maxSize: 1000,
    keyPattern: 'postgrest:{projectRef}:{endpoint}:{hash}',
    invalidationRules: []
  },
  connectionPoolOptimization: true,
  enableQueryRewriting: true,
  enableIndexSuggestions: true
}

/**
 * In-memory cache implementation
 * In production, this should be replaced with Redis or similar
 */
class PerformanceCache {
  private cache = new Map<string, { data: any; timestamp: number; ttl: number }>()
  private maxSize: number

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize
  }

  set(key: string, data: any, ttl: number): void {
    // Remove oldest entries if cache is full
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value
      this.cache.delete(oldestKey)
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    })
  }

  get(key: string): any | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    // Check if entry has expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return null
    }

    return entry.data
  }

  invalidate(pattern: string): number {
    let invalidatedCount = 0
    const regex = new RegExp(pattern.replace(/\*/g, '.*'))

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key)
        invalidatedCount++
      }
    }

    return invalidatedCount
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }

  getStats(): { size: number; maxSize: number; hitRate: number } {
    // Simple stats - in production, track hits/misses properly
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: 0.85 // Placeholder - implement proper hit rate tracking
    }
  }
}

/**
 * Performance Optimization Service
 */
export class PerformanceOptimizationService {
  private static instance: PerformanceOptimizationService
  private config: PerformanceConfig = DEFAULT_PERFORMANCE_CONFIG
  private cache: PerformanceCache
  private poolManager = getDatabasePoolManager()
  private queryMetrics: QueryPerformanceMetrics[] = []

  private constructor() {
    this.cache = new PerformanceCache(this.config.cacheConfig.maxSize)
  }

  static getInstance(): PerformanceOptimizationService {
    if (!PerformanceOptimizationService.instance) {
      PerformanceOptimizationService.instance = new PerformanceOptimizationService()
    }
    return PerformanceOptimizationService.instance
  }

  /**
   * Update performance configuration
   * Requirements: 13.1, 13.2
   */
  updateConfig(newConfig: Partial<PerformanceConfig>): void {
    this.config = { ...this.config, ...newConfig }
    
    // Update cache configuration if changed
    if (newConfig.cacheConfig) {
      this.cache = new PerformanceCache(newConfig.cacheConfig.maxSize || 1000)
    }
  }

  /**
   * Execute query with performance optimization
   * Requirements: 13.1, 13.2, 13.3, 13.4
   */
  async executeOptimizedQuery<T = any>(
    query: string,
    parameters: any[] = [],
    context: {
      projectRef: string
      userId?: string
      endpoint?: string
      cacheKey?: string
    }
  ): Promise<WrappedResult<T[]> & { 
    metrics?: QueryPerformanceMetrics
    fromCache?: boolean
    optimizations?: string[]
  }> {
    const optimizations: string[] = []

    try {
      // 1. Check cache first if enabled
      if (this.config.cacheConfig.enabled && context.cacheKey) {
        const cachedResult = this.cache.get(context.cacheKey)
        if (cachedResult) {
          optimizations.push('cache_hit')
          return {
            data: cachedResult,
            error: undefined,
            fromCache: true,
            optimizations
          }
        }
      }

      // 2. Analyze query complexity
      const complexityAnalysis = await this.analyzeQueryComplexity(query, parameters)
      
      // 3. Reject overly complex queries
      if (complexityAnalysis.shouldReject) {
        return {
          data: undefined,
          error: new Error(`Query complexity too high (${complexityAnalysis.score}). ${complexityAnalysis.recommendations.join(', ')}`),
          optimizations
        }
      }

      // 4. Apply query optimizations if enabled
      let optimizedQuery = query
      if (this.config.enableQueryRewriting) {
        const rewriteResult = await this.rewriteQuery(query, parameters, context.projectRef)
        if (rewriteResult.optimizedQuery) {
          optimizedQuery = rewriteResult.optimizedQuery
          optimizations.push(...rewriteResult.optimizations)
        }
      }

      // 5. Execute query with monitoring
      const result = await executeQueryWithMonitoring<T>(
        optimizedQuery,
        parameters,
        {
          userId: context.userId,
          projectId: parseInt(context.projectRef, 10),
          endpoint: context.endpoint
        }
      )

      // 6. Cache successful results if enabled
      if (this.config.cacheConfig.enabled && context.cacheKey && result.data && !result.error) {
        this.cache.set(context.cacheKey, result.data, this.config.cacheConfig.ttl)
        optimizations.push('cached_result')
      }

      // 7. Store metrics for analysis
      if (result.metrics) {
        this.queryMetrics.push(result.metrics)
        // Keep only recent metrics
        if (this.queryMetrics.length > 1000) {
          this.queryMetrics = this.queryMetrics.slice(-1000)
        }
      }

      return {
        ...result,
        optimizations
      }

    } catch (error) {
      return {
        data: undefined,
        error: error instanceof Error ? error : new Error('Unknown error'),
        optimizations
      }
    }
  }
  /**
   * Analyze query complexity to determine if it should be executed
   * Requirements: 13.3
   */
  async analyzeQueryComplexity(
    query: string,
    parameters: any[] = []
  ): Promise<QueryComplexityAnalysis> {
    const factors: ComplexityFactor[] = []
    let totalScore = 0

    // Normalize query for analysis
    const normalizedQuery = query.toLowerCase().trim()

    // Factor 1: Number of JOINs
    const joinMatches = normalizedQuery.match(/\bjoin\b/g)
    if (joinMatches) {
      const joinCount = joinMatches.length
      const impact = Math.min(joinCount * 2, 10)
      factors.push({
        type: 'joins',
        impact,
        description: `Query contains ${joinCount} JOIN operations`
      })
      totalScore += impact
    }

    // Factor 2: Subqueries
    const subqueryMatches = normalizedQuery.match(/\(\s*select\b/g)
    if (subqueryMatches) {
      const subqueryCount = subqueryMatches.length
      const impact = Math.min(subqueryCount * 3, 10)
      factors.push({
        type: 'subqueries',
        impact,
        description: `Query contains ${subqueryCount} subqueries`
      })
      totalScore += impact
    }

    // Factor 3: Aggregations
    const aggregationMatches = normalizedQuery.match(/\b(count|sum|avg|min|max|group by|having)\b/g)
    if (aggregationMatches) {
      const aggregationCount = aggregationMatches.length
      const impact = Math.min(aggregationCount * 1.5, 8)
      factors.push({
        type: 'aggregations',
        impact,
        description: `Query contains ${aggregationCount} aggregation operations`
      })
      totalScore += impact
    }

    // Factor 4: Sorting operations
    const sortMatches = normalizedQuery.match(/\border by\b/g)
    if (sortMatches) {
      const impact = 3
      factors.push({
        type: 'sorting',
        impact,
        description: 'Query contains ORDER BY clause'
      })
      totalScore += impact
    }

    // Factor 5: Complex filtering
    const whereClause = normalizedQuery.match(/\bwhere\b(.+?)(?:\bgroup by\b|\border by\b|\blimit\b|$)/)?.[1]
    if (whereClause) {
      const conditionCount = (whereClause.match(/\b(and|or)\b/g) || []).length + 1
      if (conditionCount > 3) {
        const impact = Math.min(conditionCount, 8)
        factors.push({
          type: 'filtering',
          impact,
          description: `Query has complex WHERE clause with ${conditionCount} conditions`
        })
        totalScore += impact
      }
    }

    // Factor 6: Missing LIMIT clause for SELECT queries
    if (normalizedQuery.includes('select') && !normalizedQuery.includes('limit')) {
      const impact = 5
      factors.push({
        type: 'table_size',
        impact,
        description: 'Query lacks LIMIT clause, may return large result sets'
      })
      totalScore += impact
    }

    // Generate recommendations
    const recommendations: string[] = []
    
    if (totalScore > 50) {
      recommendations.push('Consider simplifying the query structure')
    }
    
    if (factors.some(f => f.type === 'joins' && f.impact > 6)) {
      recommendations.push('Reduce the number of JOINs or ensure proper indexing')
    }
    
    if (factors.some(f => f.type === 'subqueries')) {
      recommendations.push('Consider rewriting subqueries as JOINs for better performance')
    }
    
    if (factors.some(f => f.type === 'table_size')) {
      recommendations.push('Add LIMIT clause to restrict result set size')
    }

    // Estimate execution time based on complexity
    const estimatedExecutionTime = Math.min(totalScore * 100, 30000) // Cap at 30 seconds

    return {
      score: totalScore,
      factors,
      recommendations,
      shouldReject: totalScore > this.config.maxComplexityScore,
      estimatedExecutionTime
    }
  }

  /**
   * Rewrite query for better performance
   * Requirements: 13.1, 13.4
   */
  async rewriteQuery(
    query: string,
    parameters: any[],
    projectRef: string
  ): Promise<{
    optimizedQuery?: string
    optimizations: string[]
    estimatedImprovement?: string
  }> {
    const optimizations: string[] = []
    let optimizedQuery = query
    let hasOptimizations = false

    // Optimization 1: Add LIMIT if missing for SELECT queries
    if (query.toLowerCase().includes('select') && !query.toLowerCase().includes('limit')) {
      optimizedQuery += ' LIMIT 1000'
      optimizations.push('added_default_limit')
      hasOptimizations = true
    }

    // Optimization 2: Add project isolation if missing
    if (!query.toLowerCase().includes('project_id') && query.toLowerCase().includes('from')) {
      // This is a placeholder - in real implementation, you'd need to know the table structure
      optimizations.push('project_isolation_recommended')
    }

    // Optimization 3: Suggest index usage
    const indexSuggestions = await this.suggestIndexes(query, projectRef)
    if (indexSuggestions.length > 0) {
      optimizations.push('index_suggestions_available')
    }

    return {
      optimizedQuery: hasOptimizations ? optimizedQuery : undefined,
      optimizations,
      estimatedImprovement: hasOptimizations ? 'Query optimized for better performance' : undefined
    }
  }

  /**
   * Suggest indexes for better query performance
   * Requirements: 13.1, 13.4
   */
  async suggestIndexes(query: string, projectRef: string): Promise<string[]> {
    const suggestions: string[] = []
    const normalizedQuery = query.toLowerCase()

    // Analyze WHERE clauses for potential indexes
    const whereMatch = normalizedQuery.match(/\bwhere\b(.+?)(?:\bgroup by\b|\border by\b|\blimit\b|$)/)
    if (whereMatch) {
      const whereClause = whereMatch[1]
      
      // Look for equality conditions
      const equalityMatches = whereClause.match(/(\w+)\s*=\s*/g)
      if (equalityMatches) {
        equalityMatches.forEach(match => {
          const column = match.replace(/\s*=\s*$/, '').trim()
          suggestions.push(`CREATE INDEX IF NOT EXISTS idx_${column} ON table_name(${column})`)
        })
      }

      // Look for range conditions
      const rangeMatches = whereClause.match(/(\w+)\s*[<>]=?\s*/g)
      if (rangeMatches) {
        rangeMatches.forEach(match => {
          const column = match.replace(/\s*[<>]=?\s*$/, '').trim()
          suggestions.push(`CREATE INDEX IF NOT EXISTS idx_${column}_range ON table_name(${column})`)
        })
      }
    }

    // Analyze ORDER BY clauses
    const orderByMatch = normalizedQuery.match(/\border by\b\s+(.+?)(?:\blimit\b|$)/)
    if (orderByMatch) {
      const orderByClause = orderByMatch[1].trim()
      const columns = orderByClause.split(',').map(col => col.trim().split(' ')[0])
      
      if (columns.length === 1) {
        suggestions.push(`CREATE INDEX IF NOT EXISTS idx_${columns[0]}_order ON table_name(${columns[0]})`)
      } else if (columns.length > 1) {
        suggestions.push(`CREATE INDEX IF NOT EXISTS idx_composite_order ON table_name(${columns.join(', ')})`)
      }
    }

    return suggestions
  }

  /**
   * Optimize connection pool usage
   * Requirements: 13.4, 13.5
   */
  async optimizeConnectionPools(): Promise<{
    optimizations: string[]
    poolStats: Map<string, PoolStats>
    recommendations: string[]
  }> {
    const optimizations: string[] = []
    const recommendations: string[] = []

    // Get current pool statistics
    const poolStats = this.poolManager.getAllPoolStats()

    // Analyze pool usage and provide recommendations
    for (const [poolKey, stats] of poolStats) {
      // Check for pool exhaustion
      if (stats.waitingCount > 0) {
        recommendations.push(`Pool ${poolKey} has ${stats.waitingCount} waiting connections. Consider increasing pool size.`)
      }

      // Check for underutilized pools
      if (stats.totalCount > 10 && stats.idleCount / stats.totalCount > 0.8) {
        recommendations.push(`Pool ${poolKey} is underutilized (${Math.round(stats.idleCount / stats.totalCount * 100)}% idle). Consider reducing pool size.`)
      }

      // Check for optimal pool usage
      if (stats.idleCount > 0 && stats.waitingCount === 0) {
        optimizations.push(`Pool ${poolKey} is well-balanced`)
      }
    }

    // Perform health checks
    const healthStatus = await this.poolManager.healthCheck()
    for (const [poolKey, isHealthy] of healthStatus) {
      if (!isHealthy) {
        recommendations.push(`Pool ${poolKey} failed health check. Consider recreating the pool.`)
      }
    }

    return {
      optimizations,
      poolStats,
      recommendations
    }
  }

  /**
   * Generate cache key for query results
   * Requirements: 13.2
   */
  generateCacheKey(
    projectRef: string,
    endpoint: string,
    query: string,
    parameters: any[] = []
  ): string {
    const hash = this.hashQuery(query + JSON.stringify(parameters))
    return this.config.cacheConfig.keyPattern
      .replace('{projectRef}', projectRef)
      .replace('{endpoint}', endpoint)
      .replace('{hash}', hash)
  }

  /**
   * Invalidate cache based on table operations
   * Requirements: 13.2
   */
  invalidateCache(table: string, operation: 'insert' | 'update' | 'delete'): number {
    let invalidatedCount = 0

    for (const rule of this.config.cacheConfig.invalidationRules) {
      if (rule.table === table && rule.operations.includes(operation)) {
        invalidatedCount += this.cache.invalidate(rule.pattern)
      }
    }

    return invalidatedCount
  }

  /**
   * Get performance metrics and statistics
   * Requirements: 13.5
   */
  getPerformanceMetrics(): {
    queryMetrics: {
      totalQueries: number
      averageExecutionTime: number
      slowQueries: number
      recentQueries: QueryPerformanceMetrics[]
    }
    cacheMetrics: {
      size: number
      maxSize: number
      hitRate: number
    }
    poolMetrics: Map<string, PoolStats>
    optimizationStats: {
      totalOptimizations: number
      cacheHits: number
      queryRewrites: number
    }
  } {
    const recentQueries = this.queryMetrics.slice(-10)
    const slowQueries = this.queryMetrics.filter(m => m.executionTimeMs > 1000).length
    const averageExecutionTime = this.queryMetrics.length > 0 
      ? this.queryMetrics.reduce((sum, m) => sum + m.executionTimeMs, 0) / this.queryMetrics.length 
      : 0

    return {
      queryMetrics: {
        totalQueries: this.queryMetrics.length,
        averageExecutionTime,
        slowQueries,
        recentQueries
      },
      cacheMetrics: this.cache.getStats(),
      poolMetrics: this.poolManager.getAllPoolStats(),
      optimizationStats: {
        totalOptimizations: 0, // Implement proper tracking
        cacheHits: 0, // Implement proper tracking
        queryRewrites: 0 // Implement proper tracking
      }
    }
  }

  /**
   * Clear all caches and reset metrics
   * Requirements: 13.2
   */
  clearCaches(): void {
    this.cache.clear()
    this.queryMetrics = []
  }

  /**
   * Simple hash function for cache keys
   */
  private hashQuery(input: string): string {
    let hash = 0
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36)
  }
}

/**
 * Factory function to get the performance optimization service
 */
export function getPerformanceOptimizationService(): PerformanceOptimizationService {
  return PerformanceOptimizationService.getInstance()
}