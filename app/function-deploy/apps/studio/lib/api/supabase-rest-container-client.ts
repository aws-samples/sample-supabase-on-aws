import { NextApiRequest, NextApiResponse } from 'next'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { EnhancedPostgRESTProjectConfig, getEnhancedPostgRESTConfigManager } from './enhanced-postgrest-config-manager'

/**
 * Supabase REST Container Client
 * Handles communication between Studio and the enhanced supabase-rest container
 * Requirements: 1.1, 2.1, 13.1
 */
export class SupabaseRestContainerClient {
  private static instance: SupabaseRestContainerClient
  private containerBaseUrl: string
  private requestTimeout: number

  private constructor() {
    this.containerBaseUrl = process.env.SUPABASE_REST_CONTAINER_URL || 'http://rest:3000'
    this.requestTimeout = parseInt(process.env.SUPABASE_REST_TIMEOUT || '30000', 10)
  }

  static getInstance(): SupabaseRestContainerClient {
    if (!SupabaseRestContainerClient.instance) {
      SupabaseRestContainerClient.instance = new SupabaseRestContainerClient()
    }
    return SupabaseRestContainerClient.instance
  }

  /**
   * Send configuration update to the supabase-rest container
   * Requirements: 1.1, 2.1
   */
  async updateContainerConfiguration(
    projectRef: string,
    config: EnhancedPostgRESTProjectConfig
  ): Promise<ContainerConfigurationResponse> {
    try {
      const configPayload: ContainerConfigurationPayload = {
        projectRef,
        databaseUrl: config.databaseUrl,
        schemas: config.schemas,
        extraSearchPath: config.extraSearchPath,
        maxRows: config.maxRows,
        jwtSecret: config.jwtSecret,
        anonRole: config.anonRole,
        
        // Enhanced features configuration
        features: {
          enableRPCFunctions: config.enableRPCFunctions,
          enableDatabaseViews: config.enableDatabaseViews,
          enableAdvancedJSON: config.enableAdvancedJSON,
          enableFullTextSearch: config.enableFullTextSearch,
          enableAggregateQueries: config.enableAggregateQueries,
          enableBulkOperations: config.enableBulkOperations,
          enableNestedResources: config.enableNestedResources,
          enableTransactions: config.enableTransactions,
          enableArrayOperations: config.enableArrayOperations,
          enableContentNegotiation: config.enableContentNegotiation
        },
        
        // Performance configuration
        performance: {
          queryTimeout: config.queryTimeout,
          connectionPoolSize: config.connectionPoolSize,
          enableQueryLogging: config.enableQueryLogging,
          enablePerformanceMonitoring: config.enablePerformanceMonitoring,
          enableCaching: config.enableCaching
        },
        
        // Connection details
        connectionDetails: config.connectionDetails,
        
        // Logging configuration
        logging: {
          logLevel: config.logLevel,
          enableRequestLogging: config.enableRequestLogging,
          enableErrorLogging: config.enableErrorLogging
        }
      }

      const response = await this.makeContainerRequest(
        'POST',
        config.containerConfigEndpoint,
        configPayload
      )

      if (!response.ok) {
        throw new Error(`Container configuration update failed: ${response.status} ${response.statusText}`)
      }

      const result = await response.json()
      
      console.log(`Successfully updated container configuration for project ${projectRef}`)
      
      return {
        success: true,
        message: result.message || 'Configuration updated successfully',
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      console.error(`Failed to update container configuration for project ${projectRef}:`, error)
      
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      }
    }
  }

  /**
   * Get health status from the supabase-rest container
   * Requirements: 13.1
   */
  async getContainerHealth(projectRef: string): Promise<ContainerHealthResponse> {
    const startTime = Date.now()
    
    try {
      // In self-hosted environments, check the actual PostgREST container health
      // Use the container name from Docker Compose (rest:3000)
      const restHost = process.env.POSTGREST_HOST || 'rest'
      const restPort = parseInt(process.env.POSTGREST_PORT || '3000', 10)
      const restUrl = `http://${restHost}:${restPort}`
      
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)
      
      try {
        const response = await fetch(restUrl, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'Accept': 'application/json'
          }
        })
        clearTimeout(timeoutId)
        
        const responseTime = Date.now() - startTime
        
        // PostgREST is healthy if it responds with any status code except 5xx
        // 404 is expected when accessing root endpoint (it tries to find public.true() function)
        // 200, 404, and other 4xx codes indicate the server is running
        const healthy = response.status < 500
        
        return {
          projectRef,
          healthy,
          status: healthy ? 'healthy' : 'unhealthy',
          responseTime,
          timestamp: new Date().toISOString(),
          details: {
            database: {
              connected: healthy,
              responseTime
            },
            features: {
              rpcFunctions: true,
              databaseViews: true,
              advancedJSON: true,
              fullTextSearch: true,
              aggregateQueries: true,
              bulkOperations: true,
              nestedResources: true,
              transactions: true,
              arrayOperations: true,
              contentNegotiation: true
            },
            performance: {
              memoryUsage: 0,
              cpuUsage: 0,
              activeConnections: 0
            }
          },
          error: healthy ? undefined : `HTTP ${response.status}: ${response.statusText}`
        }
      } catch (fetchError) {
        clearTimeout(timeoutId)
        throw fetchError
      }
    } catch (error) {
      console.error(`Container health check failed for project ${projectRef}:`, error)
      
      const responseTime = Date.now() - startTime
      
      return {
        projectRef,
        healthy: false,
        status: 'error',
        responseTime,
        timestamp: new Date().toISOString(),
        details: {
          database: {
            connected: false,
            responseTime
          },
          features: {
            rpcFunctions: false,
            databaseViews: false,
            advancedJSON: false,
            fullTextSearch: false,
            aggregateQueries: false,
            bulkOperations: false,
            nestedResources: false,
            transactions: false,
            arrayOperations: false,
            contentNegotiation: false
          },
          performance: {
            memoryUsage: 0,
            cpuUsage: 0,
            activeConnections: 0
          }
        },
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Get performance metrics from the supabase-rest container
   * Requirements: 13.1
   */
  async getContainerMetrics(projectRef: string): Promise<ContainerMetricsResponse> {
    try {
      const configManager = getEnhancedPostgRESTConfigManager()
      const config = await configManager.getEnhancedProjectConfig(
        { projectRef, userId: 'system' } as ProjectIsolationContext,
        {} as any
      )

      const response = await this.makeContainerRequest(
        'GET',
        config.containerMetricsEndpoint
      )

      if (!response.ok) {
        throw new Error(`Metrics request failed: ${response.status} ${response.statusText}`)
      }

      const metricsData = await response.json()
      
      return {
        projectRef,
        timestamp: metricsData.timestamp || new Date().toISOString(),
        metrics: {
          activeConnections: metricsData.activeConnections || 0,
          totalQueries: metricsData.totalQueries || 0,
          averageResponseTime: metricsData.averageResponseTime || 0,
          errorRate: metricsData.errorRate || 0,
          cacheHitRate: metricsData.cacheHitRate || 0,
          memoryUsage: metricsData.memoryUsage || 0,
          cpuUsage: metricsData.cpuUsage || 0
        },
        queryStats: metricsData.queryStats || {},
        errorStats: metricsData.errorStats || {}
      }
    } catch (error) {
      console.error(`Failed to get container metrics for project ${projectRef}:`, error)
      
      return {
        projectRef,
        timestamp: new Date().toISOString(),
        metrics: {
          activeConnections: 0,
          totalQueries: 0,
          averageResponseTime: 0,
          errorRate: 0,
          cacheHitRate: 0,
          memoryUsage: 0,
          cpuUsage: 0
        },
        queryStats: {},
        errorStats: {},
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Proxy a request to the enhanced supabase-rest container
   * Requirements: 1.1, 2.1
   */
  async proxyRequest(
    req: NextApiRequest,
    res: NextApiResponse,
    projectRef: string,
    path: string
  ): Promise<void> {
    try {
      // Build the target URL
      const targetUrl = `${this.containerBaseUrl}/${projectRef}${path}`
      const queryString = new URLSearchParams(req.query as Record<string, string>).toString()
      const fullUrl = queryString ? `${targetUrl}?${queryString}` : targetUrl

      // Prepare request options
      const requestOptions: RequestInit = {
        method: req.method,
        headers: this.buildProxyHeaders(req),
        signal: AbortSignal.timeout(this.requestTimeout)
      }

      // Add body for POST, PATCH, PUT requests
      if (req.method && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
        requestOptions.body = JSON.stringify(req.body)
      }

      // Make the request to the container
      const response = await fetch(fullUrl, requestOptions)

      // Copy response headers
      response.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })

      // Set status code
      res.status(response.status)

      // Stream the response body
      if (response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let result = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          result += decoder.decode(value, { stream: true })
        }

        // Try to parse as JSON, fallback to text
        try {
          const jsonData = JSON.parse(result)
          res.json(jsonData)
        } catch {
          res.send(result)
        }
      } else {
        res.end()
      }
    } catch (error) {
      console.error(`Proxy request failed for project ${projectRef}:`, error)
      
      if (error instanceof Error && error.name === 'TimeoutError') {
        res.status(504).json({
          code: 'PGRST000',
          message: 'Gateway timeout',
          details: 'The request to the REST API container timed out',
          hint: 'Try reducing the complexity of your query or check container health'
        })
      } else {
        res.status(500).json({
          code: 'PGRST000',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error',
          hint: 'Check container connectivity and configuration'
        })
      }
    }
  }

  /**
   * Make a request to the container
   * Requirements: 1.1, 13.1
   */
  private async makeContainerRequest(
    method: string,
    endpoint: string,
    body?: any,
    timeout?: number
  ): Promise<Response> {
    const url = `${this.containerBaseUrl}${endpoint}`
    const requestTimeout = timeout || this.requestTimeout

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Supabase-Studio-Container-Client',
        'X-Studio-Version': process.env.npm_package_version || '1.0.0'
      },
      signal: AbortSignal.timeout(requestTimeout)
    }

    if (body) {
      options.body = JSON.stringify(body)
    }

    return fetch(url, options)
  }

  /**
   * Build headers for proxying requests
   * Requirements: 1.1
   */
  private buildProxyHeaders(req: NextApiRequest): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Supabase-Studio-Proxy'
    }

    // Copy important headers from the original request
    const importantHeaders = [
      'authorization',
      'apikey',
      'x-client-info',
      'accept',
      'accept-language',
      'accept-encoding',
      'prefer',
      'range'
    ]

    for (const headerName of importantHeaders) {
      const headerValue = req.headers[headerName]
      if (headerValue) {
        headers[headerName] = Array.isArray(headerValue) ? headerValue[0] : headerValue
      }
    }

    return headers
  }
}

/**
 * Container configuration payload
 * Requirements: 1.1, 2.1
 */
export interface ContainerConfigurationPayload {
  projectRef: string
  databaseUrl: string
  schemas: string[]
  extraSearchPath: string[]
  maxRows: number
  jwtSecret: string
  anonRole: string
  
  features: {
    enableRPCFunctions: boolean
    enableDatabaseViews: boolean
    enableAdvancedJSON: boolean
    enableFullTextSearch: boolean
    enableAggregateQueries: boolean
    enableBulkOperations: boolean
    enableNestedResources: boolean
    enableTransactions: boolean
    enableArrayOperations: boolean
    enableContentNegotiation: boolean
  }
  
  performance: {
    queryTimeout: number
    connectionPoolSize: number
    enableQueryLogging: boolean
    enablePerformanceMonitoring: boolean
    enableCaching: boolean
  }
  
  connectionDetails: {
    host: string
    port: number
    database: string
    username: string
    password: string
    ssl: boolean
    maxConnections: number
    idleTimeoutMs: number
    connectionTimeoutMs: number
    schema: string
  }
  
  logging: {
    logLevel: string
    enableRequestLogging: boolean
    enableErrorLogging: boolean
  }
}

/**
 * Container configuration response
 * Requirements: 1.1, 2.1
 */
export interface ContainerConfigurationResponse {
  success: boolean
  message: string
  timestamp: string
}

/**
 * Container health response
 * Requirements: 13.1
 */
export interface ContainerHealthResponse {
  projectRef: string
  healthy: boolean
  status: string
  responseTime: number
  timestamp: string
  details: Record<string, any>
  error?: string
}

/**
 * Container metrics response
 * Requirements: 13.1
 */
export interface ContainerMetricsResponse {
  projectRef: string
  timestamp: string
  metrics: {
    activeConnections: number
    totalQueries: number
    averageResponseTime: number
    errorRate: number
    cacheHitRate: number
    memoryUsage: number
    cpuUsage: number
  }
  queryStats: Record<string, any>
  errorStats: Record<string, any>
  error?: string
}

/**
 * Factory function to get the container client
 */
export function getSupabaseRestContainerClient(): SupabaseRestContainerClient {
  return SupabaseRestContainerClient.getInstance()
}