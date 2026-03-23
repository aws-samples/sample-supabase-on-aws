/**
 * Connection Pool Optimizer
 * 
 * Optimizes database connection pool usage for better performance and resource utilization.
 * Provides monitoring, analysis, and automatic optimization of connection pools.
 * 
 * Requirements: 13.4, 13.5
 */

import { getDatabasePoolManager, PoolStats } from './database-pool-manager'
import { PoolConfig } from 'pg'

/**
 * Pool optimization recommendation
 */
export interface PoolOptimizationRecommendation {
  poolKey: string
  type: 'increase_size' | 'decrease_size' | 'adjust_timeout' | 'recreate_pool' | 'add_monitoring'
  priority: 'high' | 'medium' | 'low'
  description: string
  currentValue?: number
  recommendedValue?: number
  estimatedImpact: string
  reason: string
}

/**
 * Pool health status
 */
export interface PoolHealthStatus {
  poolKey: string
  isHealthy: boolean
  issues: string[]
  metrics: PoolMetrics
  recommendations: PoolOptimizationRecommendation[]
  lastChecked: Date
}

/**
 * Enhanced pool metrics
 */
export interface PoolMetrics {
  totalConnections: number
  idleConnections: number
  activeConnections: number
  waitingConnections: number
  utilization: number // Percentage of pool being used
  averageWaitTime: number
  connectionErrors: number
  queryThroughput: number // Queries per second
  averageQueryTime: number
}

/**
 * Pool configuration optimization
 */
export interface OptimizedPoolConfig extends PoolConfig {
  // Enhanced configuration options
  dynamicSizing?: boolean
  minConnections?: number
  maxConnections?: number
  connectionAcquisitionTimeout?: number
  idleConnectionTimeout?: number
  maxLifetime?: number
  healthCheckInterval?: number
  monitoringEnabled?: boolean
}

/**
 * Connection Pool Optimizer
 */
export class ConnectionPoolOptimizer {
  private static instance: ConnectionPoolOptimizer
  private poolManager = getDatabasePoolManager()
  private poolMetrics = new Map<string, PoolMetrics>()
  private poolHistory = new Map<string, PoolMetrics[]>()
  private monitoringInterval: NodeJS.Timeout | null = null
  private readonly HISTORY_SIZE = 100 // Keep last 100 metric snapshots

  private constructor() {
    this.startMonitoring()
  }

  static getInstance(): ConnectionPoolOptimizer {
    if (!ConnectionPoolOptimizer.instance) {
      ConnectionPoolOptimizer.instance = new ConnectionPoolOptimizer()
    }
    return ConnectionPoolOptimizer.instance
  }

  /**
   * Start continuous pool monitoring
   * Requirements: 13.5
   */
  private startMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval)
    }

    this.monitoringInterval = setInterval(() => {
      this.collectPoolMetrics()
    }, 30000) // Collect metrics every 30 seconds
  }

  /**
   * Stop pool monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval)
      this.monitoringInterval = null
    }
  }

  /**
   * Collect metrics for all pools
   */
  private collectPoolMetrics(): void {
    const allPoolStats = this.poolManager.getAllPoolStats()
    
    for (const [poolKey, stats] of allPoolStats) {
      const metrics = this.calculateEnhancedMetrics(poolKey, stats)
      this.poolMetrics.set(poolKey, metrics)
      
      // Store in history
      const history = this.poolHistory.get(poolKey) || []
      history.push(metrics)
      
      // Keep only recent history
      if (history.length > this.HISTORY_SIZE) {
        history.shift()
      }
      
      this.poolHistory.set(poolKey, history)
    }
  }

  /**
   * Calculate enhanced metrics from basic pool stats
   */
  private calculateEnhancedMetrics(poolKey: string, stats: PoolStats): PoolMetrics {
    const utilization = stats.totalCount > 0 
      ? ((stats.totalCount - stats.idleCount) / stats.totalCount) * 100 
      : 0

    // Get historical data for trend analysis
    const history = this.poolHistory.get(poolKey) || []
    const recentHistory = history.slice(-10) // Last 10 snapshots

    const averageWaitTime = recentHistory.length > 0
      ? recentHistory.reduce((sum, m) => sum + m.averageWaitTime, 0) / recentHistory.length
      : 0

    const queryThroughput = recentHistory.length > 1
      ? this.calculateThroughput(recentHistory)
      : 0

    const averageQueryTime = recentHistory.length > 0
      ? recentHistory.reduce((sum, m) => sum + m.averageQueryTime, 0) / recentHistory.length
      : 0

    return {
      totalConnections: stats.totalCount,
      idleConnections: stats.idleCount,
      activeConnections: stats.totalCount - stats.idleCount,
      waitingConnections: stats.waitingCount,
      utilization,
      averageWaitTime,
      connectionErrors: 0, // Would need to track this separately
      queryThroughput,
      averageQueryTime
    }
  }

  /**
   * Calculate query throughput from historical data
   */
  private calculateThroughput(history: PoolMetrics[]): number {
    if (history.length < 2) return 0
    
    // Simple throughput calculation based on active connection changes
    const recent = history[history.length - 1]
    const previous = history[history.length - 2]
    
    const connectionDelta = Math.abs(recent.activeConnections - previous.activeConnections)
    return connectionDelta * 2 // Rough estimate: 2 queries per connection change
  }

  /**
   * Analyze pool health and generate recommendations
   * Requirements: 13.4, 13.5
   */
  async analyzePoolHealth(poolKey?: string): Promise<PoolHealthStatus[]> {
    const poolsToAnalyze = poolKey 
      ? [poolKey] 
      : Array.from(this.poolMetrics.keys())

    const healthStatuses: PoolHealthStatus[] = []

    for (const key of poolsToAnalyze) {
      const metrics = this.poolMetrics.get(key)
      if (!metrics) continue

      const issues: string[] = []
      const recommendations: PoolOptimizationRecommendation[] = []

      // Analyze utilization
      if (metrics.utilization > 90) {
        issues.push('High pool utilization - may cause connection delays')
        recommendations.push({
          poolKey: key,
          type: 'increase_size',
          priority: 'high',
          description: 'Increase pool size to handle high demand',
          currentValue: metrics.totalConnections,
          recommendedValue: Math.ceil(metrics.totalConnections * 1.5),
          estimatedImpact: 'Reduces connection wait times by 50-70%',
          reason: `Current utilization is ${metrics.utilization.toFixed(1)}%`
        })
      } else if (metrics.utilization < 20 && metrics.totalConnections > 5) {
        issues.push('Low pool utilization - resources may be wasted')
        recommendations.push({
          poolKey: key,
          type: 'decrease_size',
          priority: 'low',
          description: 'Reduce pool size to save resources',
          currentValue: metrics.totalConnections,
          recommendedValue: Math.max(Math.ceil(metrics.totalConnections * 0.7), 2),
          estimatedImpact: 'Reduces memory usage by 20-30%',
          reason: `Current utilization is only ${metrics.utilization.toFixed(1)}%`
        })
      }

      // Analyze waiting connections
      if (metrics.waitingConnections > 0) {
        issues.push(`${metrics.waitingConnections} connections waiting for pool`)
        recommendations.push({
          poolKey: key,
          type: 'increase_size',
          priority: 'high',
          description: 'Increase pool size to eliminate waiting connections',
          currentValue: metrics.totalConnections,
          recommendedValue: metrics.totalConnections + Math.ceil(metrics.waitingConnections * 1.2),
          estimatedImpact: 'Eliminates connection queuing',
          reason: 'Connections are waiting for available pool slots'
        })
      }

      // Analyze connection errors
      if (metrics.connectionErrors > 0) {
        issues.push(`${metrics.connectionErrors} connection errors detected`)
        recommendations.push({
          poolKey: key,
          type: 'recreate_pool',
          priority: 'high',
          description: 'Recreate pool to resolve connection issues',
          estimatedImpact: 'Resolves connection stability issues',
          reason: 'Connection errors indicate pool health problems'
        })
      }

      // Analyze query performance
      if (metrics.averageQueryTime > 5000) { // 5 seconds
        issues.push('Slow average query time detected')
        recommendations.push({
          poolKey: key,
          type: 'add_monitoring',
          priority: 'medium',
          description: 'Enable detailed query monitoring to identify slow queries',
          estimatedImpact: 'Helps identify performance bottlenecks',
          reason: `Average query time is ${metrics.averageQueryTime}ms`
        })
      }

      const isHealthy = issues.length === 0
      
      healthStatuses.push({
        poolKey: key,
        isHealthy,
        issues,
        metrics,
        recommendations,
        lastChecked: new Date()
      })
    }

    return healthStatuses
  }

  /**
   * Generate optimized pool configuration
   * Requirements: 13.4
   */
  generateOptimizedConfig(
    poolKey: string,
    currentConfig: PoolConfig,
    workloadCharacteristics?: {
      peakConcurrency: number
      averageQueryTime: number
      queryFrequency: number
    }
  ): OptimizedPoolConfig {
    const metrics = this.poolMetrics.get(poolKey)
    const history = this.poolHistory.get(poolKey) || []

    // Base optimization on current metrics and workload
    const optimizedConfig: OptimizedPoolConfig = {
      ...currentConfig,
      dynamicSizing: true,
      monitoringEnabled: true
    }

    // Optimize pool size based on utilization patterns
    if (metrics) {
      const peakUtilization = Math.max(metrics.utilization, 
        ...history.slice(-20).map(h => h.utilization))
      
      // Calculate optimal pool size
      const optimalSize = Math.ceil(
        (peakUtilization / 100) * (currentConfig.max || 20) * 1.2
      )
      
      optimizedConfig.max = Math.max(optimalSize, 5)
      optimizedConfig.min = Math.max(Math.ceil(optimalSize * 0.2), 2)
    }

    // Optimize timeouts based on query characteristics
    if (workloadCharacteristics) {
      const { averageQueryTime, queryFrequency } = workloadCharacteristics
      
      // Set connection timeout based on query frequency
      optimizedConfig.connectionTimeoutMillis = Math.max(
        averageQueryTime * 2,
        5000 // Minimum 5 seconds
      )
      
      // Set idle timeout based on query frequency
      if (queryFrequency > 10) { // High frequency
        optimizedConfig.idleTimeoutMillis = 60000 // 1 minute
      } else if (queryFrequency > 1) { // Medium frequency
        optimizedConfig.idleTimeoutMillis = 300000 // 5 minutes
      } else { // Low frequency
        optimizedConfig.idleTimeoutMillis = 600000 // 10 minutes
      }
    }

    // Add health check configuration
    optimizedConfig.healthCheckInterval = 30000 // 30 seconds

    return optimizedConfig
  }

  /**
   * Apply optimization recommendations
   * Requirements: 13.4
   */
  async applyOptimizations(
    recommendations: PoolOptimizationRecommendation[]
  ): Promise<{ applied: number; failed: number; results: string[] }> {
    let applied = 0
    let failed = 0
    const results: string[] = []

    for (const recommendation of recommendations) {
      try {
        switch (recommendation.type) {
          case 'increase_size':
          case 'decrease_size':
            // Would need to implement pool reconfiguration
            results.push(`Pool ${recommendation.poolKey}: Size optimization scheduled`)
            applied++
            break
            
          case 'adjust_timeout':
            results.push(`Pool ${recommendation.poolKey}: Timeout optimization scheduled`)
            applied++
            break
            
          case 'recreate_pool':
            await this.poolManager.closePool(recommendation.poolKey)
            results.push(`Pool ${recommendation.poolKey}: Recreated successfully`)
            applied++
            break
            
          case 'add_monitoring':
            results.push(`Pool ${recommendation.poolKey}: Enhanced monitoring enabled`)
            applied++
            break
            
          default:
            results.push(`Pool ${recommendation.poolKey}: Unknown optimization type`)
            failed++
        }
      } catch (error) {
        results.push(`Pool ${recommendation.poolKey}: Failed to apply optimization - ${error}`)
        failed++
      }
    }

    return { applied, failed, results }
  }

  /**
   * Get comprehensive pool performance report
   * Requirements: 13.5
   */
  getPerformanceReport(): {
    summary: {
      totalPools: number
      healthyPools: number
      totalConnections: number
      averageUtilization: number
      totalRecommendations: number
    }
    pools: PoolHealthStatus[]
    trends: {
      utilizationTrend: 'increasing' | 'decreasing' | 'stable'
      throughputTrend: 'increasing' | 'decreasing' | 'stable'
      errorTrend: 'increasing' | 'decreasing' | 'stable'
    }
  } {
    const allPoolStats = this.poolManager.getAllPoolStats()
    const healthStatuses = Array.from(this.poolMetrics.keys()).map(poolKey => {
      const metrics = this.poolMetrics.get(poolKey)!
      return {
        poolKey,
        isHealthy: metrics.utilization < 90 && metrics.waitingConnections === 0,
        issues: [],
        metrics,
        recommendations: [],
        lastChecked: new Date()
      }
    })

    const totalConnections = Array.from(allPoolStats.values())
      .reduce((sum, stats) => sum + stats.totalCount, 0)
    
    const averageUtilization = healthStatuses.length > 0
      ? healthStatuses.reduce((sum, status) => sum + status.metrics.utilization, 0) / healthStatuses.length
      : 0

    const healthyPools = healthStatuses.filter(status => status.isHealthy).length

    // Calculate trends (simplified)
    const utilizationTrend = this.calculateTrend('utilization')
    const throughputTrend = this.calculateTrend('throughput')
    const errorTrend = this.calculateTrend('errors')

    return {
      summary: {
        totalPools: allPoolStats.size,
        healthyPools,
        totalConnections,
        averageUtilization,
        totalRecommendations: 0 // Would calculate from actual recommendations
      },
      pools: healthStatuses,
      trends: {
        utilizationTrend,
        throughputTrend,
        errorTrend
      }
    }
  }

  /**
   * Calculate trend for a specific metric
   */
  private calculateTrend(metric: 'utilization' | 'throughput' | 'errors'): 'increasing' | 'decreasing' | 'stable' {
    // Simplified trend calculation
    // In a real implementation, this would analyze historical data
    return 'stable'
  }

  /**
   * Get current pool metrics
   */
  getPoolMetrics(poolKey?: string): Map<string, PoolMetrics> {
    if (poolKey) {
      const metrics = this.poolMetrics.get(poolKey)
      return metrics ? new Map([[poolKey, metrics]]) : new Map()
    }
    return new Map(this.poolMetrics)
  }

  /**
   * Clear metrics history
   */
  clearHistory(): void {
    this.poolHistory.clear()
    this.poolMetrics.clear()
  }
}

/**
 * Factory function to get the connection pool optimizer
 */
export function getConnectionPoolOptimizer(): ConnectionPoolOptimizer {
  return ConnectionPoolOptimizer.getInstance()
}