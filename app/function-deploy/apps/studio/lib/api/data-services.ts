import { getProjectIsolationMiddleware } from './project-isolation-middleware'
import { 
  ProjectManagementError, 
  ErrorFactory, 
  createErrorContext,
  withErrorHandling 
} from './error-handling'

/**
 * Common data filters for querying
 */
export interface DataFilters {
  limit?: number
  offset?: number
  startDate?: Date
  endDate?: Date
  search?: string
}

/**
 * Monitoring data model
 */
export interface MonitoringData {
  id: number
  project_id: number
  metric_name: string
  metric_value: number
  metadata?: Record<string, any>
  timestamp: Date
  created_at: Date
}

/**
 * Advisor data model
 */
export interface AdvisorData {
  id: number
  project_id: number
  advisor_type: string
  recommendation: string
  severity: 'info' | 'warning' | 'critical'
  metadata?: Record<string, any>
  created_at: Date
  resolved_at?: Date
}

/**
 * Log data model
 */
export interface LogData {
  id: number
  project_id: number
  log_level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  metadata?: Record<string, any>
  timestamp: Date
}

/**
 * Base data service with common project isolation functionality
 */
abstract class BaseDataService {
  protected middleware = getProjectIsolationMiddleware()

  /**
   * Execute a query with automatic project filtering
   * 
   * @param query - Base SQL query
   * @param projectId - Project ID for filtering
   * @param params - Additional query parameters
   * @returns Query result
   * @throws ProjectManagementError if query execution fails
   */
  protected async executeProjectQuery(
    query: string,
    projectId: number,
    params: any[] = []
  ): Promise<any[]> {
    const errorContext = createErrorContext('executeProjectQuery', { projectId })

    return withErrorHandling(
      async () => {
        // Validate inputs
        if (!query || typeof query !== 'string') {
          throw ErrorFactory.validation.invalidInput('query', 'Query must be a non-empty string', errorContext)
        }

        if (!projectId || typeof projectId !== 'number' || projectId <= 0) {
          throw ErrorFactory.dataIsolation.invalidProjectId(projectId, errorContext)
        }

        const isolatedQuery = this.middleware.addProjectFilter(query, projectId)
        
        // In a real implementation, this would execute the query against the database
        // For now, we'll return mock data for testing
        console.log('Executing isolated query:', {
          query: isolatedQuery.baseQuery + isolatedQuery.projectFilter,
          params: [...params, ...isolatedQuery.params]
        })
        
        // Mock implementation - replace with actual database query execution
        const result = await this.executeMockQuery(isolatedQuery, params)
        
        // Validate that all returned data belongs to the project
        this.validateProjectOwnership(result, projectId)
        
        return result
      },
      errorContext,
      (cause) => ErrorFactory.dataIsolation.queryFailed('project data', cause, errorContext)
    )
  }

  /**
   * Mock query execution for testing purposes
   * This should be replaced with actual database query execution
   */
  private async executeMockQuery(isolatedQuery: any, params: any[]): Promise<any[]> {
    // Return empty array for mock implementation
    return []
  }

  /**
   * Validate that data belongs to the specified project
   * 
   * @param data - Data to validate
   * @param projectId - Expected project ID
   * @throws ProjectManagementError if validation fails
   */
  protected validateProjectOwnership(data: any, projectId: number): void {
    try {
      this.middleware.validateDataOwnership(data, projectId)
    } catch (error) {
      if (error instanceof ProjectManagementError) {
        throw error
      }
      
      throw ErrorFactory.dataIsolation.ownershipViolation(
        'Data ownership validation failed',
        createErrorContext('validateProjectOwnership', { projectId })
      )
    }
  }
}

/**
 * Service for managing monitoring data with project isolation
 * Requirements: 2.1, 2.2
 */
export class MonitoringDataService extends BaseDataService {
  /**
   * Get monitoring data for a specific project
   * 
   * @param projectId - Project ID
   * @param filters - Optional filters
   * @returns Array of monitoring data records
   */
  async getMonitoringData(projectId: number, filters?: DataFilters): Promise<MonitoringData[]> {
    let query = `
      SELECT id, project_id, metric_name, metric_value, metadata, timestamp, created_at
      FROM public.monitoring_data
    `

    const params: any[] = []
    let paramIndex = 1

    // Add filters
    if (filters?.startDate) {
      query += ` AND timestamp >= $${paramIndex}`
      params.push(filters.startDate)
      paramIndex++
    }

    if (filters?.endDate) {
      query += ` AND timestamp <= $${paramIndex}`
      params.push(filters.endDate)
      paramIndex++
    }

    if (filters?.search) {
      query += ` AND metric_name ILIKE $${paramIndex}`
      params.push(`%${filters.search}%`)
      paramIndex++
    }

    // Add ordering and pagination
    query += ` ORDER BY timestamp DESC`

    if (filters?.limit) {
      query += ` LIMIT $${paramIndex}`
      params.push(filters.limit)
      paramIndex++
    }

    if (filters?.offset) {
      query += ` OFFSET $${paramIndex}`
      params.push(filters.offset)
      paramIndex++
    }

    const results = await this.executeProjectQuery(query, projectId, params)
    this.validateProjectOwnership(results, projectId)
    
    return results as MonitoringData[]
  }

  /**
   * Save monitoring data (automatically associates with project ID)
   * 
   * @param projectId - Project ID
   * @param data - Monitoring data to save (without id and project_id)
   * @returns Saved monitoring data record
   */
  async saveMonitoringData(
    projectId: number,
    data: Omit<MonitoringData, 'id' | 'project_id'>
  ): Promise<MonitoringData> {
    const query = `
      INSERT INTO public.monitoring_data 
      (project_id, metric_name, metric_value, metadata, timestamp, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, project_id, metric_name, metric_value, metadata, timestamp, created_at
    `

    const params = [
      projectId,
      data.metric_name,
      data.metric_value,
      data.metadata || {},
      data.timestamp || new Date(),
      data.created_at || new Date()
    ]

    // Mock implementation - in real code this would execute the INSERT query
    console.log('Saving monitoring data:', { query, params })
    
    // Return mock saved record
    const savedRecord: MonitoringData = {
      id: Math.floor(Math.random() * 10000),
      project_id: projectId,
      metric_name: data.metric_name,
      metric_value: data.metric_value,
      metadata: data.metadata,
      timestamp: data.timestamp || new Date(),
      created_at: data.created_at || new Date()
    }

    this.validateProjectOwnership(savedRecord, projectId)
    return savedRecord
  }
}

/**
 * Service for managing advisor data with project isolation
 * Requirements: 2.3, 2.4
 */
export class AdvisorDataService extends BaseDataService {
  /**
   * Get advisor data for a specific project
   * 
   * @param projectId - Project ID
   * @param filters - Optional filters
   * @returns Array of advisor data records
   */
  async getAdvisorData(projectId: number, filters?: DataFilters): Promise<AdvisorData[]> {
    let query = `
      SELECT id, project_id, advisor_type, recommendation, severity, metadata, created_at, resolved_at
      FROM public.advisor_data
    `

    const params: any[] = []
    let paramIndex = 1

    // Add filters
    if (filters?.startDate) {
      query += ` AND created_at >= $${paramIndex}`
      params.push(filters.startDate)
      paramIndex++
    }

    if (filters?.endDate) {
      query += ` AND created_at <= $${paramIndex}`
      params.push(filters.endDate)
      paramIndex++
    }

    if (filters?.search) {
      query += ` AND (advisor_type ILIKE $${paramIndex} OR recommendation ILIKE $${paramIndex})`
      params.push(`%${filters.search}%`)
      paramIndex++
    }

    // Add ordering and pagination
    query += ` ORDER BY created_at DESC`

    if (filters?.limit) {
      query += ` LIMIT $${paramIndex}`
      params.push(filters.limit)
      paramIndex++
    }

    if (filters?.offset) {
      query += ` OFFSET $${paramIndex}`
      params.push(filters.offset)
      paramIndex++
    }

    const results = await this.executeProjectQuery(query, projectId, params)
    this.validateProjectOwnership(results, projectId)
    
    return results as AdvisorData[]
  }

  /**
   * Save advisor data (automatically associates with project ID)
   * 
   * @param projectId - Project ID
   * @param data - Advisor data to save (without id and project_id)
   * @returns Saved advisor data record
   */
  async saveAdvisorData(
    projectId: number,
    data: Omit<AdvisorData, 'id' | 'project_id'>
  ): Promise<AdvisorData> {
    const query = `
      INSERT INTO public.advisor_data 
      (project_id, advisor_type, recommendation, severity, metadata, created_at, resolved_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, project_id, advisor_type, recommendation, severity, metadata, created_at, resolved_at
    `

    const params = [
      projectId,
      data.advisor_type,
      data.recommendation,
      data.severity,
      data.metadata || {},
      data.created_at || new Date(),
      data.resolved_at || null
    ]

    // Mock implementation - in real code this would execute the INSERT query
    console.log('Saving advisor data:', { query, params })
    
    // Return mock saved record
    const savedRecord: AdvisorData = {
      id: Math.floor(Math.random() * 10000),
      project_id: projectId,
      advisor_type: data.advisor_type,
      recommendation: data.recommendation,
      severity: data.severity,
      metadata: data.metadata,
      created_at: data.created_at || new Date(),
      resolved_at: data.resolved_at
    }

    this.validateProjectOwnership(savedRecord, projectId)
    return savedRecord
  }
}

/**
 * Service for managing log data with project isolation
 * Requirements: 2.5, 2.6
 */
export class LogDataService extends BaseDataService {
  /**
   * Get log data for a specific project
   * 
   * @param projectId - Project ID
   * @param filters - Optional filters
   * @returns Array of log data records
   */
  async getLogData(projectId: number, filters?: DataFilters): Promise<LogData[]> {
    let query = `
      SELECT id, project_id, log_level, message, metadata, timestamp
      FROM public.log_data
    `

    const params: any[] = []
    let paramIndex = 1

    // Add filters
    if (filters?.startDate) {
      query += ` AND timestamp >= $${paramIndex}`
      params.push(filters.startDate)
      paramIndex++
    }

    if (filters?.endDate) {
      query += ` AND timestamp <= $${paramIndex}`
      params.push(filters.endDate)
      paramIndex++
    }

    if (filters?.search) {
      query += ` AND message ILIKE $${paramIndex}`
      params.push(`%${filters.search}%`)
      paramIndex++
    }

    // Add ordering and pagination
    query += ` ORDER BY timestamp DESC`

    if (filters?.limit) {
      query += ` LIMIT $${paramIndex}`
      params.push(filters.limit)
      paramIndex++
    }

    if (filters?.offset) {
      query += ` OFFSET $${paramIndex}`
      params.push(filters.offset)
      paramIndex++
    }

    const results = await this.executeProjectQuery(query, projectId, params)
    this.validateProjectOwnership(results, projectId)
    
    return results as LogData[]
  }

  /**
   * Save log data (automatically associates with project ID)
   * 
   * @param projectId - Project ID
   * @param data - Log data to save (without id and project_id)
   * @returns Saved log data record
   */
  async saveLogData(
    projectId: number,
    data: Omit<LogData, 'id' | 'project_id'>
  ): Promise<LogData> {
    const query = `
      INSERT INTO public.log_data 
      (project_id, log_level, message, metadata, timestamp)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, project_id, log_level, message, metadata, timestamp
    `

    const params = [
      projectId,
      data.log_level,
      data.message,
      data.metadata || {},
      data.timestamp || new Date()
    ]

    // Mock implementation - in real code this would execute the INSERT query
    console.log('Saving log data:', { query, params })
    
    // Return mock saved record
    const savedRecord: LogData = {
      id: Math.floor(Math.random() * 10000),
      project_id: projectId,
      log_level: data.log_level,
      message: data.message,
      metadata: data.metadata,
      timestamp: data.timestamp || new Date()
    }

    this.validateProjectOwnership(savedRecord, projectId)
    return savedRecord
  }
}

/**
 * Factory functions for getting service instances
 */
export function getMonitoringDataService(): MonitoringDataService {
  return new MonitoringDataService()
}

export function getAdvisorDataService(): AdvisorDataService {
  return new AdvisorDataService()
}

export function getLogDataService(): LogDataService {
  return new LogDataService()
}