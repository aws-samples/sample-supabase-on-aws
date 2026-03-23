/**
 * Enhanced data services with comprehensive error handling
 * 
 * This module provides enhanced versions of the data services with:
 * - Comprehensive error handling and validation
 * - User-friendly error messages and recovery options
 * - Proper logging and monitoring integration
 * - Robust input validation and sanitization
 * 
 * Requirements: All error handling scenarios for data isolation
 */

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
 * Enhanced base data service with comprehensive error handling
 */
abstract class EnhancedBaseDataService {
  protected middleware = getProjectIsolationMiddleware()

  /**
   * Execute a query with automatic project filtering and comprehensive error handling
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
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
          throw ErrorFactory.validation.invalidInput('query', 'Query must be a non-empty string', errorContext)
        }

        if (!projectId || typeof projectId !== 'number' || projectId <= 0) {
          throw ErrorFactory.dataIsolation.invalidProjectId(projectId, errorContext)
        }

        if (!Array.isArray(params)) {
          throw ErrorFactory.validation.invalidInput('params', 'Parameters must be an array', errorContext)
        }

        try {
          const isolatedQuery = this.middleware.addProjectFilter(query, projectId)
          
          // In a real implementation, this would execute the query against the database
          console.log('Executing isolated query:', {
            query: isolatedQuery.baseQuery + isolatedQuery.projectFilter,
            params: [...params, ...isolatedQuery.params],
            timestamp: new Date().toISOString()
          })
          
          // Mock implementation - replace with actual database query execution
          const result = await this.executeMockQuery(isolatedQuery, params, projectId)
          
          // Validate that all returned data belongs to the project
          this.validateProjectOwnership(result, projectId)
          
          return result
        } catch (dbError) {
          // Handle database-specific errors
          if (dbError instanceof ProjectManagementError) {
            throw dbError
          }
          
          throw ErrorFactory.dataIsolation.queryFailed('database', dbError as Error, errorContext)
        }
      },
      errorContext,
      (cause) => ErrorFactory.dataIsolation.queryFailed('project data', cause, errorContext)
    )
  }

  /**
   * Enhanced mock query execution with error simulation
   */
  private async executeMockQuery(isolatedQuery: any, params: any[], projectId: number): Promise<any[]> {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100))
    
    // Simulate occasional database errors for testing
    if (Math.random() < 0.01) { // 1% chance of simulated error
      throw new Error('Simulated database connection error')
    }
    
    // Return mock data that includes project_id for validation
    return [
      {
        id: Math.floor(Math.random() * 10000),
        project_id: projectId,
        created_at: new Date(),
        // Additional mock fields will be added by specific services
      }
    ]
  }

  /**
   * Validate that data belongs to the specified project with enhanced error handling
   * 
   * @param data - Data to validate
   * @param projectId - Expected project ID
   * @throws ProjectManagementError if validation fails
   */
  protected validateProjectOwnership(data: any, projectId: number): void {
    const errorContext = createErrorContext('validateProjectOwnership', { projectId })

    try {
      this.middleware.validateDataOwnership(data, projectId)
    } catch (error) {
      if (error instanceof ProjectManagementError) {
        throw error
      }
      
      throw ErrorFactory.dataIsolation.ownershipViolation(
        `Data ownership validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        errorContext
      )
    }
  }

  /**
   * Validate common data filters with comprehensive validation
   * 
   * @param filters - Data filters to validate
   * @param errorContext - Error context for logging
   * @throws ProjectManagementError if validation fails
   */
  protected validateDataFilters(filters: DataFilters | undefined, errorContext: any): void {
    if (!filters) return

    // Validate limit
    if (filters.limit !== undefined) {
      if (typeof filters.limit !== 'number' || !Number.isInteger(filters.limit)) {
        throw ErrorFactory.validation.invalidInput('limit', 'Limit must be an integer', errorContext)
      }
      if (filters.limit < 1 || filters.limit > 1000) {
        throw ErrorFactory.validation.invalidInput('limit', 'Limit must be between 1 and 1000', errorContext)
      }
    }

    // Validate offset
    if (filters.offset !== undefined) {
      if (typeof filters.offset !== 'number' || !Number.isInteger(filters.offset)) {
        throw ErrorFactory.validation.invalidInput('offset', 'Offset must be an integer', errorContext)
      }
      if (filters.offset < 0) {
        throw ErrorFactory.validation.invalidInput('offset', 'Offset must be non-negative', errorContext)
      }
    }

    // Validate dates
    if (filters.startDate !== undefined) {
      if (!(filters.startDate instanceof Date) || isNaN(filters.startDate.getTime())) {
        throw ErrorFactory.validation.invalidInput('startDate', 'Start date must be a valid Date object', errorContext)
      }
    }

    if (filters.endDate !== undefined) {
      if (!(filters.endDate instanceof Date) || isNaN(filters.endDate.getTime())) {
        throw ErrorFactory.validation.invalidInput('endDate', 'End date must be a valid Date object', errorContext)
      }
    }

    // Validate date range
    if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
      throw ErrorFactory.validation.invalidInput('dateRange', 'Start date must be before end date', errorContext)
    }

    // Validate search string
    if (filters.search !== undefined) {
      if (typeof filters.search !== 'string') {
        throw ErrorFactory.validation.invalidInput('search', 'Search must be a string', errorContext)
      }
      if (filters.search.length > 1000) {
        throw ErrorFactory.validation.invalidInput('search', 'Search string must be 1000 characters or less', errorContext)
      }
    }
  }
}

/**
 * Enhanced monitoring data service with comprehensive error handling
 * Requirements: 2.1, 2.2
 */
export class EnhancedMonitoringDataService extends EnhancedBaseDataService {
  /**
   * Get monitoring data for a specific project with comprehensive error handling
   * 
   * @param projectId - Project ID
   * @param filters - Optional filters
   * @returns Array of monitoring data records
   * @throws ProjectManagementError if data retrieval fails
   */
  async getMonitoringData(projectId: number, filters?: DataFilters): Promise<MonitoringData[]> {
    const errorContext = createErrorContext('getMonitoringData', { projectId })

    return withErrorHandling(
      async () => {
        // Validate project ID
        if (!projectId || typeof projectId !== 'number' || projectId <= 0) {
          throw ErrorFactory.dataIsolation.invalidProjectId(projectId, errorContext)
        }

        // Validate filters
        this.validateDataFilters(filters, errorContext)

        let query = `
          SELECT id, project_id, metric_name, metric_value, metadata, timestamp, created_at
          FROM public.monitoring_data
        `

        const params: any[] = []
        let paramIndex = 1

        // Add filters with proper parameter binding
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
        
        // Transform results to ensure proper typing
        return results.map(row => ({
          ...row,
          timestamp: new Date(row.timestamp),
          created_at: new Date(row.created_at)
        })) as MonitoringData[]
      },
      errorContext,
      (cause) => ErrorFactory.dataIsolation.queryFailed('monitoring', cause, errorContext)
    )
  }

  /**
   * Save monitoring data with comprehensive validation and error handling
   * 
   * @param projectId - Project ID
   * @param data - Monitoring data to save (without id and project_id)
   * @returns Saved monitoring data record
   * @throws ProjectManagementError if save operation fails
   */
  async saveMonitoringData(
    projectId: number,
    data: Omit<MonitoringData, 'id' | 'project_id'>
  ): Promise<MonitoringData> {
    const errorContext = createErrorContext('saveMonitoringData', { projectId })

    return withErrorHandling(
      async () => {
        // Validate project ID
        if (!projectId || typeof projectId !== 'number' || projectId <= 0) {
          throw ErrorFactory.dataIsolation.invalidProjectId(projectId, errorContext)
        }

        // Validate required fields
        if (!data.metric_name || typeof data.metric_name !== 'string' || data.metric_name.trim().length === 0) {
          throw ErrorFactory.validation.missingRequiredField('metric_name', errorContext)
        }

        if (data.metric_value === undefined || typeof data.metric_value !== 'number' || !isFinite(data.metric_value)) {
          throw ErrorFactory.validation.invalidInput('metric_value', 'Metric value must be a finite number', errorContext)
        }

        // Validate optional fields
        if (data.metadata !== undefined && (typeof data.metadata !== 'object' || Array.isArray(data.metadata) || data.metadata === null)) {
          throw ErrorFactory.validation.invalidInput('metadata', 'Metadata must be an object', errorContext)
        }

        if (data.timestamp && (!(data.timestamp instanceof Date) || isNaN(data.timestamp.getTime()))) {
          throw ErrorFactory.validation.invalidInput('timestamp', 'Timestamp must be a valid Date object', errorContext)
        }

        if (data.created_at && (!(data.created_at instanceof Date) || isNaN(data.created_at.getTime()))) {
          throw ErrorFactory.validation.invalidInput('created_at', 'Created at must be a valid Date object', errorContext)
        }

        // Validate metric name length and format
        if (data.metric_name.length > 255) {
          throw ErrorFactory.validation.invalidInput('metric_name', 'Metric name must be 255 characters or less', errorContext)
        }

        const query = `
          INSERT INTO public.monitoring_data 
          (project_id, metric_name, metric_value, metadata, timestamp, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, project_id, metric_name, metric_value, metadata, timestamp, created_at
        `

        const now = new Date()
        const params = [
          projectId,
          data.metric_name.trim(),
          data.metric_value,
          data.metadata || {},
          data.timestamp || now,
          data.created_at || now
        ]

        // Mock implementation - in real code this would execute the INSERT query
        console.log('Saving monitoring data:', { query, params, timestamp: now.toISOString() })
        
        // Return mock saved record with proper validation
        const savedRecord: MonitoringData = {
          id: Math.floor(Math.random() * 10000) + 1,
          project_id: projectId,
          metric_name: data.metric_name.trim(),
          metric_value: data.metric_value,
          metadata: data.metadata || {},
          timestamp: data.timestamp || now,
          created_at: data.created_at || now
        }

        // Validate the saved record
        this.validateProjectOwnership(savedRecord, projectId)
        
        return savedRecord
      },
      errorContext,
      (cause) => ErrorFactory.dataIsolation.queryFailed('monitoring save', cause, errorContext)
    )
  }
}

/**
 * Enhanced advisor data service with comprehensive error handling
 * Requirements: 2.3, 2.4
 */
export class EnhancedAdvisorDataService extends EnhancedBaseDataService {
  private readonly validSeverities = ['info', 'warning', 'critical'] as const

  /**
   * Get advisor data for a specific project with comprehensive error handling
   * 
   * @param projectId - Project ID
   * @param filters - Optional filters
   * @returns Array of advisor data records
   * @throws ProjectManagementError if data retrieval fails
   */
  async getAdvisorData(projectId: number, filters?: DataFilters): Promise<AdvisorData[]> {
    const errorContext = createErrorContext('getAdvisorData', { projectId })

    return withErrorHandling(
      async () => {
        // Validate project ID
        if (!projectId || typeof projectId !== 'number' || projectId <= 0) {
          throw ErrorFactory.dataIsolation.invalidProjectId(projectId, errorContext)
        }

        // Validate filters
        this.validateDataFilters(filters, errorContext)

        let query = `
          SELECT id, project_id, advisor_type, recommendation, severity, metadata, created_at, resolved_at
          FROM public.advisor_data
        `

        const params: any[] = []
        let paramIndex = 1

        // Add filters with proper parameter binding
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
          query += ` AND (advisor_type ILIKE $${paramIndex} OR recommendation ILIKE $${paramIndex + 1})`
          params.push(`%${filters.search}%`, `%${filters.search}%`)
          paramIndex += 2
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
        
        // Transform results to ensure proper typing
        return results.map(row => ({
          ...row,
          created_at: new Date(row.created_at),
          resolved_at: row.resolved_at ? new Date(row.resolved_at) : undefined
        })) as AdvisorData[]
      },
      errorContext,
      (cause) => ErrorFactory.dataIsolation.queryFailed('advisor', cause, errorContext)
    )
  }

  /**
   * Save advisor data with comprehensive validation and error handling
   * 
   * @param projectId - Project ID
   * @param data - Advisor data to save (without id and project_id)
   * @returns Saved advisor data record
   * @throws ProjectManagementError if save operation fails
   */
  async saveAdvisorData(
    projectId: number,
    data: Omit<AdvisorData, 'id' | 'project_id'>
  ): Promise<AdvisorData> {
    const errorContext = createErrorContext('saveAdvisorData', { projectId })

    return withErrorHandling(
      async () => {
        // Validate project ID
        if (!projectId || typeof projectId !== 'number' || projectId <= 0) {
          throw ErrorFactory.dataIsolation.invalidProjectId(projectId, errorContext)
        }

        // Validate required fields
        if (!data.advisor_type || typeof data.advisor_type !== 'string' || data.advisor_type.trim().length === 0) {
          throw ErrorFactory.validation.missingRequiredField('advisor_type', errorContext)
        }

        if (!data.recommendation || typeof data.recommendation !== 'string' || data.recommendation.trim().length === 0) {
          throw ErrorFactory.validation.missingRequiredField('recommendation', errorContext)
        }

        if (!data.severity || !this.validSeverities.includes(data.severity)) {
          throw ErrorFactory.validation.invalidInput(
            'severity', 
            `Severity must be one of: ${this.validSeverities.join(', ')}`, 
            errorContext
          )
        }

        // Validate field lengths
        if (data.advisor_type.length > 100) {
          throw ErrorFactory.validation.invalidInput('advisor_type', 'Advisor type must be 100 characters or less', errorContext)
        }

        if (data.recommendation.length > 10000) {
          throw ErrorFactory.validation.invalidInput('recommendation', 'Recommendation must be 10,000 characters or less', errorContext)
        }

        // Validate optional fields
        if (data.metadata !== undefined && (typeof data.metadata !== 'object' || Array.isArray(data.metadata) || data.metadata === null)) {
          throw ErrorFactory.validation.invalidInput('metadata', 'Metadata must be an object', errorContext)
        }

        if (data.created_at && (!(data.created_at instanceof Date) || isNaN(data.created_at.getTime()))) {
          throw ErrorFactory.validation.invalidInput('created_at', 'Created at must be a valid Date object', errorContext)
        }

        if (data.resolved_at && (!(data.resolved_at instanceof Date) || isNaN(data.resolved_at.getTime()))) {
          throw ErrorFactory.validation.invalidInput('resolved_at', 'Resolved at must be a valid Date object', errorContext)
        }

        const query = `
          INSERT INTO public.advisor_data 
          (project_id, advisor_type, recommendation, severity, metadata, created_at, resolved_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, project_id, advisor_type, recommendation, severity, metadata, created_at, resolved_at
        `

        const now = new Date()
        const params = [
          projectId,
          data.advisor_type.trim(),
          data.recommendation.trim(),
          data.severity,
          data.metadata || {},
          data.created_at || now,
          data.resolved_at || null
        ]

        // Mock implementation - in real code this would execute the INSERT query
        console.log('Saving advisor data:', { query, params, timestamp: now.toISOString() })
        
        // Return mock saved record with proper validation
        const savedRecord: AdvisorData = {
          id: Math.floor(Math.random() * 10000) + 1,
          project_id: projectId,
          advisor_type: data.advisor_type.trim(),
          recommendation: data.recommendation.trim(),
          severity: data.severity,
          metadata: data.metadata || {},
          created_at: data.created_at || now,
          resolved_at: data.resolved_at
        }

        // Validate the saved record
        this.validateProjectOwnership(savedRecord, projectId)
        
        return savedRecord
      },
      errorContext,
      (cause) => ErrorFactory.dataIsolation.queryFailed('advisor save', cause, errorContext)
    )
  }
}

/**
 * Enhanced log data service with comprehensive error handling
 * Requirements: 2.5, 2.6
 */
export class EnhancedLogDataService extends EnhancedBaseDataService {
  private readonly validLogLevels = ['debug', 'info', 'warn', 'error'] as const

  /**
   * Get log data for a specific project with comprehensive error handling
   * 
   * @param projectId - Project ID
   * @param filters - Optional filters
   * @returns Array of log data records
   * @throws ProjectManagementError if data retrieval fails
   */
  async getLogData(projectId: number, filters?: DataFilters): Promise<LogData[]> {
    const errorContext = createErrorContext('getLogData', { projectId })

    return withErrorHandling(
      async () => {
        // Validate project ID
        if (!projectId || typeof projectId !== 'number' || projectId <= 0) {
          throw ErrorFactory.dataIsolation.invalidProjectId(projectId, errorContext)
        }

        // Validate filters
        this.validateDataFilters(filters, errorContext)

        let query = `
          SELECT id, project_id, log_level, message, metadata, timestamp
          FROM public.log_data
        `

        const params: any[] = []
        let paramIndex = 1

        // Add filters with proper parameter binding
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
        
        // Transform results to ensure proper typing
        return results.map(row => ({
          ...row,
          timestamp: new Date(row.timestamp)
        })) as LogData[]
      },
      errorContext,
      (cause) => ErrorFactory.dataIsolation.queryFailed('log', cause, errorContext)
    )
  }

  /**
   * Save log data with comprehensive validation and error handling
   * 
   * @param projectId - Project ID
   * @param data - Log data to save (without id and project_id)
   * @returns Saved log data record
   * @throws ProjectManagementError if save operation fails
   */
  async saveLogData(
    projectId: number,
    data: Omit<LogData, 'id' | 'project_id'>
  ): Promise<LogData> {
    const errorContext = createErrorContext('saveLogData', { projectId })

    return withErrorHandling(
      async () => {
        // Validate project ID
        if (!projectId || typeof projectId !== 'number' || projectId <= 0) {
          throw ErrorFactory.dataIsolation.invalidProjectId(projectId, errorContext)
        }

        // Validate required fields
        if (!data.log_level || !this.validLogLevels.includes(data.log_level)) {
          throw ErrorFactory.validation.invalidInput(
            'log_level', 
            `Log level must be one of: ${this.validLogLevels.join(', ')}`, 
            errorContext
          )
        }

        if (!data.message || typeof data.message !== 'string' || data.message.trim().length === 0) {
          throw ErrorFactory.validation.missingRequiredField('message', errorContext)
        }

        // Validate field lengths
        if (data.message.length > 10000) {
          throw ErrorFactory.validation.invalidInput('message', 'Log message must be 10,000 characters or less', errorContext)
        }

        // Validate optional fields
        if (data.metadata !== undefined && (typeof data.metadata !== 'object' || Array.isArray(data.metadata) || data.metadata === null)) {
          throw ErrorFactory.validation.invalidInput('metadata', 'Metadata must be an object', errorContext)
        }

        if (data.timestamp && (!(data.timestamp instanceof Date) || isNaN(data.timestamp.getTime()))) {
          throw ErrorFactory.validation.invalidInput('timestamp', 'Timestamp must be a valid Date object', errorContext)
        }

        const query = `
          INSERT INTO public.log_data 
          (project_id, log_level, message, metadata, timestamp)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, project_id, log_level, message, metadata, timestamp
        `

        const now = new Date()
        const params = [
          projectId,
          data.log_level,
          data.message.trim(),
          data.metadata || {},
          data.timestamp || now
        ]

        // Mock implementation - in real code this would execute the INSERT query
        console.log('Saving log data:', { query, params, timestamp: now.toISOString() })
        
        // Return mock saved record with proper validation
        const savedRecord: LogData = {
          id: Math.floor(Math.random() * 10000) + 1,
          project_id: projectId,
          log_level: data.log_level,
          message: data.message.trim(),
          metadata: data.metadata || {},
          timestamp: data.timestamp || now
        }

        // Validate the saved record
        this.validateProjectOwnership(savedRecord, projectId)
        
        return savedRecord
      },
      errorContext,
      (cause) => ErrorFactory.dataIsolation.queryFailed('log save', cause, errorContext)
    )
  }
}

/**
 * Factory functions for getting enhanced service instances
 */
export function getEnhancedMonitoringDataService(): EnhancedMonitoringDataService {
  return new EnhancedMonitoringDataService()
}

export function getEnhancedAdvisorDataService(): EnhancedAdvisorDataService {
  return new EnhancedAdvisorDataService()
}

export function getEnhancedLogDataService(): EnhancedLogDataService {
  return new EnhancedLogDataService()
}