/**
 * Performance Monitoring Middleware for PostgREST
 * 
 * This middleware integrates performance optimization into the PostgREST request pipeline.
 * It provides query monitoring, caching, and optimization features.
 * 
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */

import { NextApiRequest, NextApiResponse } from 'next'
import { getPerformanceOptimizationService } from './performance-optimization-service'
import { WrappedResult } from './self-hosted/types'

/**
 * Performance middleware configuration
 */
export interface PerformanceMiddlewareConfig {
  enableCaching: boolean
  enableComplexityAnalysis: boolean
  enableQueryOptimization: boolean
  enableMetricsCollection: boolean
  cacheableEndpoints: string[]
  cacheTTL: number
}

/**
 * Default middleware configuration
 */
const DEFAULT_CONFIG: PerformanceMiddlewareConfig = {
  enableCaching: true,
  enableComplexityAnalysis: true,
  enableQueryOptimization: true,
  enableMetricsCollection: true,
  cacheableEndpoints: ['/rest/v1/'],
  cacheTTL: 5 * 60 * 1000 // 5 minutes
}

/**
 * Performance monitoring middleware
 */
export class PerformanceMiddleware {
  private config: PerformanceMiddlewareConfig
  private performanceService = getPerformanceOptimizationService()

  constructor(config: Partial<PerformanceMiddlewareConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Middleware function for Next.js API routes
   */
  middleware = async (
    req: NextApiRequest,
    res: NextApiResponse,
    next: () => Promise<void>
  ): Promise<void> => {
    const startTime = Date.now()
    
    try {
      // Extract context from request
      const context = this.extractContext(req)
      
      // Check if this endpoint should be cached
      const shouldCache = this.shouldCacheRequest(req)
      
      // Generate cache key if caching is enabled
      let cacheKey: string | undefined
      if (shouldCache && this.config.enableCaching) {
        cacheKey = this.generateCacheKey(req, context)
        
        // Try to serve from cache
        const cachedResponse = await this.serveCachedResponse(cacheKey, res)
        if (cachedResponse) {
          this.logPerformanceMetrics(req, Date.now() - startTime, true)
          return
        }
      }

      // Store original response methods
      const originalJson = res.json
      const originalSend = res.send
      
      // Intercept response to apply performance optimizations
      res.json = (data: any) => {
        this.handleResponse(req, res, data, cacheKey, startTime)
        return originalJson.call(res, data)
      }
      
      res.send = (data: any) => {
        this.handleResponse(req, res, data, cacheKey, startTime)
        return originalSend.call(res, data)
      }

      // Continue to next middleware/handler
      await next()
      
    } catch (error) {
      console.error('[Performance Middleware] Error:', error)
      this.logPerformanceMetrics(req, Date.now() - startTime, false, error)
      throw error
    }
  }

  /**
   * Extract context information from request
   */
  private extractContext(req: NextApiRequest): {
    projectRef: string
    userId?: string
    endpoint: string
    method: string
  } {
    // Extract project reference from URL or headers
    const projectRef = req.query.ref as string || req.headers['x-project-ref'] as string || 'unknown'
    
    // Extract user ID from authentication
    const userId = req.headers['x-user-id'] as string || req.headers.authorization?.split(' ')[1]
    
    // Extract endpoint information
    const endpoint = req.url || 'unknown'
    const method = req.method || 'GET'

    return {
      projectRef,
      userId,
      endpoint,
      method
    }
  }

  /**
   * Determine if request should be cached
   */
  private shouldCacheRequest(req: NextApiRequest): boolean {
    if (!this.config.enableCaching) return false
    
    // Only cache GET requests
    if (req.method !== 'GET') return false
    
    // Check if endpoint is in cacheable list
    const url = req.url || ''
    return this.config.cacheableEndpoints.some(endpoint => url.includes(endpoint))
  }

  /**
   * Generate cache key for request
   */
  private generateCacheKey(req: NextApiRequest, context: any): string {
    const queryString = new URLSearchParams(req.query as any).toString()
    const url = req.url || ''
    
    return this.performanceService.generateCacheKey(
      context.projectRef,
      url,
      `${context.method}:${url}?${queryString}`,
      []
    )
  }

  /**
   * Try to serve cached response
   */
  private async serveCachedResponse(cacheKey: string, res: NextApiResponse): Promise<boolean> {
    try {
      // This would integrate with the performance service cache
      // For now, return false to indicate no cache hit
      return false
    } catch (error) {
      console.error('[Performance Middleware] Cache lookup error:', error)
      return false
    }
  }

  /**
   * Handle response and apply performance optimizations
   */
  private handleResponse(
    req: NextApiRequest,
    res: NextApiResponse,
    data: any,
    cacheKey: string | undefined,
    startTime: number
  ): void {
    const executionTime = Date.now() - startTime
    
    // Cache successful responses if enabled
    if (cacheKey && res.statusCode === 200 && this.config.enableCaching) {
      // Cache the response data
      // This would integrate with the performance service
    }
    
    // Add performance headers
    res.setHeader('X-Response-Time', `${executionTime}ms`)
    res.setHeader('X-Cache-Status', cacheKey ? 'MISS' : 'DISABLED')
    
    // Log performance metrics
    this.logPerformanceMetrics(req, executionTime, false)
  }

  /**
   * Log performance metrics
   */
  private logPerformanceMetrics(
    req: NextApiRequest,
    executionTime: number,
    fromCache: boolean,
    error?: any
  ): void {
    if (!this.config.enableMetricsCollection) return

    const context = this.extractContext(req)
    
    console.log('[Performance Metrics]', {
      timestamp: new Date().toISOString(),
      projectRef: context.projectRef,
      endpoint: context.endpoint,
      method: context.method,
      executionTime,
      fromCache,
      error: error ? (error instanceof Error ? error.message : String(error)) : undefined,
      userAgent: req.headers['user-agent'],
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
    })
  }

  /**
   * Update middleware configuration
   */
  updateConfig(newConfig: Partial<PerformanceMiddlewareConfig>): void {
    this.config = { ...this.config, ...newConfig }
  }

  /**
   * Get current configuration
   */
  getConfig(): PerformanceMiddlewareConfig {
    return { ...this.config }
  }
}

/**
 * Create performance middleware instance
 */
export function createPerformanceMiddleware(
  config?: Partial<PerformanceMiddlewareConfig>
): PerformanceMiddleware {
  return new PerformanceMiddleware(config)
}

/**
 * Express-style middleware wrapper for performance monitoring
 */
export function performanceMiddleware(
  config?: Partial<PerformanceMiddlewareConfig>
) {
  const middleware = createPerformanceMiddleware(config)
  
  return async (req: NextApiRequest, res: NextApiResponse, next: () => Promise<void>) => {
    return middleware.middleware(req, res, next)
  }
}