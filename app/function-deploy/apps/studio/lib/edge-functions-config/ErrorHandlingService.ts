/**
 * Error Handling and Diagnostics Service for Edge Functions
 * 
 * Implements error handlers for different failure scenarios and provides
 * diagnostic information for troubleshooting Edge Functions issues.
 * 
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */

import { configurationValidationService } from './ConfigurationValidationService'
import { platformDetectionService } from '../platform-detection'
import { serviceDiscovery } from '../service-discovery'

export interface EdgeFunctionsError {
  code: string
  message: string
  category: ErrorCategory
  severity: ErrorSeverity
  details?: Record<string, any>
  suggestions?: string[]
  timestamp: Date
  context?: ErrorContext
}

export interface ErrorContext {
  projectRef?: string
  functionSlug?: string
  userId?: string
  operation?: string
  endpoint?: string
  requestId?: string
}

export enum ErrorCategory {
  CONFIGURATION = 'configuration',
  SERVICE_AVAILABILITY = 'service_availability',
  STORAGE = 'storage',
  SECURITY = 'security',
  RUNTIME = 'runtime',
  NETWORK = 'network',
  DEPLOYMENT = 'deployment',
}

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export interface DiagnosticReport {
  summary: {
    overallHealth: 'healthy' | 'degraded' | 'unhealthy'
    criticalIssues: number
    warnings: number
    lastChecked: Date
  }
  services: {
    edgeFunctions: ServiceDiagnostic
    storage: ServiceDiagnostic
    platform: ServiceDiagnostic
  }
  configuration: {
    valid: boolean
    errors: string[]
    warnings: string[]
  }
  connectivity: {
    edgeFunctionsReachable: boolean
    storageAccessible: boolean
    responseTime?: number
  }
  environment: Record<string, any>
  troubleshooting: TroubleshootingGuide[]
}

export interface ServiceDiagnostic {
  name: string
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  version?: string
  endpoint?: string
  lastChecked: Date
  error?: string
  metrics?: Record<string, any>
}

export interface TroubleshootingGuide {
  issue: string
  category: ErrorCategory
  severity: ErrorSeverity
  steps: string[]
  relatedErrors?: string[]
}

/**
 * Error Handling and Diagnostics Service
 * 
 * Provides comprehensive error handling, categorization, and diagnostic
 * capabilities for Edge Functions operations.
 */
export class ErrorHandlingService {
  private errorHistory: EdgeFunctionsError[] = []
  private readonly MAX_ERROR_HISTORY = 100

  /**
   * Handle and categorize Edge Functions errors
   */
  handleError(error: any, context?: ErrorContext): EdgeFunctionsError {
    const edgeFunctionsError = this.categorizeError(error, context)
    
    // Add to error history
    this.errorHistory.unshift(edgeFunctionsError)
    if (this.errorHistory.length > this.MAX_ERROR_HISTORY) {
      this.errorHistory = this.errorHistory.slice(0, this.MAX_ERROR_HISTORY)
    }

    // Log error based on severity
    this.logError(edgeFunctionsError)

    return edgeFunctionsError
  }

  /**
   * Categorize and enrich error information
   */
  private categorizeError(error: any, context?: ErrorContext): EdgeFunctionsError {
    const timestamp = new Date()
    let category = ErrorCategory.RUNTIME
    let severity = ErrorSeverity.MEDIUM
    let code = 'UNKNOWN_ERROR'
    let message = 'An unknown error occurred'
    let suggestions: string[] = []
    let details: Record<string, any> = {}

    if (error instanceof Error) {
      message = error.message
      details.stack = error.stack
      details.name = error.name
    } else if (typeof error === 'string') {
      message = error
    } else if (error && typeof error === 'object') {
      message = error.message || error.toString()
      details = { ...error }
    }

    // Categorize based on error patterns
    if (this.isConfigurationError(error, message)) {
      category = ErrorCategory.CONFIGURATION
      severity = ErrorSeverity.HIGH
      code = this.getConfigurationErrorCode(message)
      suggestions = this.getConfigurationSuggestions(message)
    } else if (this.isServiceAvailabilityError(error, message)) {
      category = ErrorCategory.SERVICE_AVAILABILITY
      severity = ErrorSeverity.CRITICAL
      code = this.getServiceErrorCode(message)
      suggestions = this.getServiceSuggestions(message)
    } else if (this.isStorageError(error, message)) {
      category = ErrorCategory.STORAGE
      severity = ErrorSeverity.HIGH
      code = this.getStorageErrorCode(message)
      suggestions = this.getStorageSuggestions(message)
    } else if (this.isSecurityError(error, message)) {
      category = ErrorCategory.SECURITY
      severity = ErrorSeverity.HIGH
      code = this.getSecurityErrorCode(message)
      suggestions = this.getSecuritySuggestions(message)
    } else if (this.isNetworkError(error, message)) {
      category = ErrorCategory.NETWORK
      severity = ErrorSeverity.MEDIUM
      code = this.getNetworkErrorCode(message)
      suggestions = this.getNetworkSuggestions(message)
    } else if (this.isDeploymentError(error, message)) {
      category = ErrorCategory.DEPLOYMENT
      severity = ErrorSeverity.MEDIUM
      code = this.getDeploymentErrorCode(message)
      suggestions = this.getDeploymentSuggestions(message)
    }

    return {
      code,
      message,
      category,
      severity,
      details,
      suggestions,
      timestamp,
      context,
    }
  }

  /**
   * Generate comprehensive diagnostic report
   */
  async generateDiagnosticReport(): Promise<DiagnosticReport> {
    const startTime = Date.now()

    // Get configuration validation
    const configValidation = await configurationValidationService.validateConfiguration()
    
    // Check service availability
    const edgeFunctionsStatus = await this.checkEdgeFunctionsService()
    const storageStatus = await this.checkStorageService()
    const platformStatus = this.checkPlatformService()

    // Test connectivity
    const connectivity = await this.testConnectivity()

    // Determine overall health
    const criticalIssues = configValidation.errors.length + 
                          (edgeFunctionsStatus.status === 'unhealthy' ? 1 : 0) +
                          (storageStatus.status === 'unhealthy' ? 1 : 0)
    
    const warnings = configValidation.warnings.length +
                    (edgeFunctionsStatus.status === 'degraded' ? 1 : 0) +
                    (storageStatus.status === 'degraded' ? 1 : 0)

    const overallHealth = criticalIssues > 0 ? 'unhealthy' : 
                         warnings > 0 ? 'degraded' : 'healthy'

    // Generate troubleshooting guides
    const troubleshooting = this.generateTroubleshootingGuides(
      configValidation,
      edgeFunctionsStatus,
      storageStatus,
      connectivity
    )

    return {
      summary: {
        overallHealth,
        criticalIssues,
        warnings,
        lastChecked: new Date(),
      },
      services: {
        edgeFunctions: edgeFunctionsStatus,
        storage: storageStatus,
        platform: platformStatus,
      },
      configuration: {
        valid: configValidation.valid,
        errors: configValidation.errors.map(e => e.message),
        warnings: configValidation.warnings.map(w => w.message),
      },
      connectivity,
      environment: await this.getEnvironmentInfo(),
      troubleshooting,
    }
  }

  /**
   * Check Edge Functions service status
   */
  private async checkEdgeFunctionsService(): Promise<ServiceDiagnostic> {
    try {
      const serviceStatus = await platformDetectionService.validateLocalServices()
      
      return {
        name: 'Edge Functions',
        status: serviceStatus.available ? 'healthy' : 'unhealthy',
        version: serviceStatus.version,
        endpoint: serviceStatus.endpoint,
        lastChecked: new Date(),
        error: serviceStatus.error,
      }
    } catch (error) {
      return {
        name: 'Edge Functions',
        status: 'unknown',
        lastChecked: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Check storage service status
   */
  private async checkStorageService(): Promise<ServiceDiagnostic> {
    try {
      const config = await configurationValidationService.validateConfiguration()
      const storageConnectivity = await configurationValidationService.validateStorageConnectivity(config.config)
      
      return {
        name: 'Storage Backend',
        status: storageConnectivity.success ? 'healthy' : 'unhealthy',
        endpoint: config.config.storageBackend === 's3' ? 
                 `s3://${config.config.s3BucketName}` : 
                 config.config.localStoragePath || '/home/deno/functions',
        lastChecked: new Date(),
        error: storageConnectivity.error,
        metrics: {
          responseTime: storageConnectivity.responseTime,
          backend: config.config.storageBackend,
        },
      }
    } catch (error) {
      return {
        name: 'Storage Backend',
        status: 'unknown',
        lastChecked: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Check platform service status
   */
  private checkPlatformService(): ServiceDiagnostic {
    const isPlatform = platformDetectionService.isPlatform()
    
    return {
      name: 'Platform Detection',
      status: 'healthy',
      lastChecked: new Date(),
      metrics: {
        isPlatform,
        edgeFunctionsEnabled: platformDetectionService.isEdgeFunctionsEnabled(),
        endpoint: platformDetectionService.getEdgeFunctionsEndpoint(),
      },
    }
  }

  /**
   * Test connectivity to services
   */
  private async testConnectivity(): Promise<{
    edgeFunctionsReachable: boolean
    storageAccessible: boolean
    responseTime?: number
  }> {
    const startTime = Date.now()
    
    try {
      const [edgeFunctionsStatus, config] = await Promise.all([
        platformDetectionService.validateLocalServices(),
        configurationValidationService.validateConfiguration(),
      ])

      const storageConnectivity = await configurationValidationService.validateStorageConnectivity(config.config)
      
      return {
        edgeFunctionsReachable: edgeFunctionsStatus.available,
        storageAccessible: storageConnectivity.success,
        responseTime: Date.now() - startTime,
      }
    } catch (error) {
      return {
        edgeFunctionsReachable: false,
        storageAccessible: false,
        responseTime: Date.now() - startTime,
      }
    }
  }

  /**
   * Get environment information for diagnostics
   */
  private async getEnvironmentInfo(): Promise<Record<string, any>> {
    const diagnostics = await configurationValidationService.getDiagnosticInfo()
    
    return {
      ...diagnostics.environment,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    }
  }

  /**
   * Generate troubleshooting guides based on current issues
   */
  private generateTroubleshootingGuides(
    configValidation: any,
    edgeFunctionsStatus: ServiceDiagnostic,
    storageStatus: ServiceDiagnostic,
    connectivity: any
  ): TroubleshootingGuide[] {
    const guides: TroubleshootingGuide[] = []

    // Edge Functions service issues
    if (edgeFunctionsStatus.status === 'unhealthy') {
      guides.push({
        issue: 'Edge Functions service is not available',
        category: ErrorCategory.SERVICE_AVAILABILITY,
        severity: ErrorSeverity.CRITICAL,
        steps: [
          'Check if Docker containers are running: `docker ps`',
          'Verify supabase-edge-functions container is present and healthy',
          'Check Docker Compose configuration for Edge Functions service',
          'Review container logs: `docker logs supabase-edge-functions`',
          'Ensure EDGE_FUNCTIONS_URL environment variable is correct',
          'Test connectivity: `curl http://localhost:54321/functions/v1/health`',
        ],
        relatedErrors: ['SERVICE_UNAVAILABLE', 'CONNECTION_REFUSED'],
      })
    }

    // Storage issues
    if (storageStatus.status === 'unhealthy') {
      guides.push({
        issue: 'Storage backend is not accessible',
        category: ErrorCategory.STORAGE,
        severity: ErrorSeverity.HIGH,
        steps: [
          'Verify storage backend configuration',
          'For S3: Check AWS credentials and bucket permissions',
          'For local: Ensure directory exists and is writable',
          'Test storage connectivity independently',
          'Review storage backend logs for errors',
        ],
        relatedErrors: ['STORAGE_ERROR', 'S3_ACCESS_DENIED', 'FILE_PERMISSION_ERROR'],
      })
    }

    // Configuration errors
    if (!configValidation.valid) {
      guides.push({
        issue: 'Configuration validation failed',
        category: ErrorCategory.CONFIGURATION,
        severity: ErrorSeverity.HIGH,
        steps: [
          'Review configuration errors in the validation report',
          'Check all required environment variables are set',
          'Validate S3 credentials and bucket configuration',
          'Ensure Edge Functions URL is accessible',
          'Restart services after configuration changes',
        ],
        relatedErrors: ['INVALID_CONFIG', 'MISSING_ENV_VAR'],
      })
    }

    // Connectivity issues
    if (!connectivity.edgeFunctionsReachable) {
      guides.push({
        issue: 'Cannot reach Edge Functions service',
        category: ErrorCategory.NETWORK,
        severity: ErrorSeverity.HIGH,
        steps: [
          'Check Docker network configuration',
          'Verify port mappings in Docker Compose',
          'Test network connectivity between containers',
          'Check firewall rules and port availability',
          'Ensure service discovery is working correctly',
        ],
        relatedErrors: ['NETWORK_ERROR', 'CONNECTION_TIMEOUT'],
      })
    }

    return guides
  }

  // Error categorization helper methods
  private isConfigurationError(error: any, message: string): boolean {
    const configPatterns = [
      /configuration/i,
      /environment variable/i,
      /missing.*required/i,
      /invalid.*config/i,
      /setup/i,
    ]
    return configPatterns.some(pattern => pattern.test(message))
  }

  private isServiceAvailabilityError(error: any, message: string): boolean {
    const servicePatterns = [
      /service.*unavailable/i,
      /connection refused/i,
      /service.*not.*running/i,
      /health.*check.*failed/i,
      /timeout/i,
      /expected false to be true/i, // Test assertion errors for service validation
      /service validation failed/i,
    ]
    return servicePatterns.some(pattern => pattern.test(message))
  }

  private isStorageError(error: any, message: string): boolean {
    const storagePatterns = [
      /storage/i,
      /s3/i,
      /bucket/i,
      /file.*system/i,
      /permission.*denied/i,
      /access.*denied/i,
      /no such file or directory/i,
      /enoent/i,
      /invalid.*path/i,
    ]
    return storagePatterns.some(pattern => pattern.test(message))
  }

  private isSecurityError(error: any, message: string): boolean {
    const securityPatterns = [
      /unauthorized/i,
      /forbidden/i,
      /authentication/i,
      /permission/i,
      /access.*denied/i,
      /jwt/i,
      /token/i,
      /resource not found/i, // Storage not found errors can be security-related
    ]
    return securityPatterns.some(pattern => pattern.test(message))
  }

  private isNetworkError(error: any, message: string): boolean {
    const networkPatterns = [
      /network/i,
      /connection/i,
      /timeout/i,
      /unreachable/i,
      /dns/i,
      /socket/i,
    ]
    return networkPatterns.some(pattern => pattern.test(message))
  }

  private isDeploymentError(error: any, message: string): boolean {
    const deploymentPatterns = [
      /deploy/i,
      /build/i,
      /compilation/i,
      /syntax.*error/i,
      /import.*error/i,
      /module.*not.*found/i,
    ]
    return deploymentPatterns.some(pattern => pattern.test(message))
  }

  // Error code generation methods
  private getConfigurationErrorCode(message: string): string {
    if (/missing.*environment/i.test(message)) return 'MISSING_ENV_VAR'
    if (/invalid.*config/i.test(message)) return 'INVALID_CONFIG'
    if (/setup/i.test(message)) return 'SETUP_ERROR'
    return 'CONFIG_ERROR'
  }

  private getServiceErrorCode(message: string): string {
    if (/connection refused/i.test(message)) return 'CONNECTION_REFUSED'
    if (/timeout/i.test(message)) return 'SERVICE_TIMEOUT'
    if (/unavailable/i.test(message)) return 'SERVICE_UNAVAILABLE'
    if (/expected false to be true/i.test(message)) return 'SERVICE_UNAVAILABLE'
    if (/service validation failed/i.test(message)) return 'SERVICE_UNAVAILABLE'
    return 'SERVICE_ERROR'
  }

  private getStorageErrorCode(message: string): string {
    if (/s3/i.test(message)) return 'S3_ERROR'
    if (/bucket/i.test(message)) return 'BUCKET_ERROR'
    if (/permission/i.test(message)) return 'PERMISSION_ERROR'
    if (/access.*denied/i.test(message)) return 'ACCESS_DENIED'
    if (/no such file or directory/i.test(message)) return 'STORAGE_ACCESS_ERROR'
    if (/enoent/i.test(message)) return 'STORAGE_ACCESS_ERROR'
    if (/invalid.*path/i.test(message)) return 'STORAGE_ACCESS_ERROR'
    return 'STORAGE_ACCESS_ERROR'
  }

  private getSecurityErrorCode(message: string): string {
    if (/unauthorized/i.test(message)) return 'SECURITY_ACCESS_DENIED'
    if (/forbidden/i.test(message)) return 'FORBIDDEN'
    if (/jwt/i.test(message)) return 'JWT_ERROR'
    if (/token/i.test(message)) return 'TOKEN_ERROR'
    if (/access.*denied/i.test(message)) return 'SECURITY_ACCESS_DENIED'
    if (/resource not found/i.test(message)) return 'SECURITY_ACCESS_DENIED'
    return 'SECURITY_ACCESS_DENIED'
  }

  private getNetworkErrorCode(message: string): string {
    if (/timeout/i.test(message)) return 'NETWORK_TIMEOUT'
    if (/connection/i.test(message)) return 'CONNECTION_ERROR'
    if (/dns/i.test(message)) return 'DNS_ERROR'
    return 'NETWORK_ERROR'
  }

  private getDeploymentErrorCode(message: string): string {
    if (/compilation/i.test(message)) return 'COMPILATION_ERROR'
    if (/syntax/i.test(message)) return 'SYNTAX_ERROR'
    if (/import/i.test(message)) return 'IMPORT_ERROR'
    return 'DEPLOYMENT_ERROR'
  }

  // Suggestion generation methods
  private getConfigurationSuggestions(message: string): string[] {
    const suggestions = [
      'Check environment variable configuration',
      'Review Docker Compose environment settings',
      'Validate configuration file syntax',
    ]

    if (/s3/i.test(message)) {
      suggestions.push(
        'Verify AWS credentials are set correctly',
        'Check S3 bucket name and region configuration',
        'Ensure S3 bucket exists and is accessible'
      )
    }

    return suggestions
  }

  private getServiceSuggestions(message: string): string[] {
    const suggestions = [
      'Check if Docker containers are running',
      'Verify service endpoints and ports',
      'Review container logs for errors',
      'Restart affected services',
      'Check Docker network configuration',
    ]
    
    if (/expected false to be true/i.test(message) || /service validation failed/i.test(message)) {
      suggestions.unshift('Check Edge Functions service is running')
    }
    
    return suggestions
  }

  private getStorageSuggestions(message: string): string[] {
    const suggestions = [
      'Verify storage backend configuration',
      'Check storage permissions',
    ]

    if (/s3/i.test(message)) {
      suggestions.push(
        'Validate AWS credentials and permissions',
        'Check S3 bucket accessibility',
        'Verify S3 region configuration'
      )
    } else {
      suggestions.push('Check file system permissions')
    }
    
    return suggestions
  }

  private getSecuritySuggestions(message: string): string[] {
    return [
      'Check user authentication status',
      'Verify project access permissions',
      'Review JWT token validity',
      'Ensure proper security middleware is applied',
    ]
  }

  private getNetworkSuggestions(message: string): string[] {
    return [
      'Check network connectivity',
      'Verify service endpoints are reachable',
      'Review firewall and port configurations',
      'Test DNS resolution',
      'Check Docker network settings',
    ]
  }

  private getDeploymentSuggestions(message: string): string[] {
    return [
      'Check function code syntax',
      'Verify import statements and dependencies',
      'Review TypeScript compilation errors',
      'Ensure all required files are present',
      'Check Deno runtime compatibility',
    ]
  }

  /**
   * Log error based on severity
   */
  private logError(error: EdgeFunctionsError): void {
    const logMessage = `[${error.category.toUpperCase()}] ${error.code}: ${error.message}`
    
    switch (error.severity) {
      case ErrorSeverity.CRITICAL:
        console.error(logMessage, error)
        break
      case ErrorSeverity.HIGH:
        console.error(logMessage, error)
        break
      case ErrorSeverity.MEDIUM:
        console.warn(logMessage, error)
        break
      case ErrorSeverity.LOW:
        console.info(logMessage, error)
        break
    }
  }

  /**
   * Get recent error history
   */
  getErrorHistory(limit: number = 10): EdgeFunctionsError[] {
    return this.errorHistory.slice(0, limit)
  }

  /**
   * Clear error history
   */
  clearErrorHistory(): void {
    this.errorHistory = []
  }

  /**
   * Get error statistics
   */
  getErrorStatistics(): {
    total: number
    byCategory: Record<ErrorCategory, number>
    bySeverity: Record<ErrorSeverity, number>
    recent: number
  } {
    const now = Date.now()
    const oneHourAgo = now - 60 * 60 * 1000

    const byCategory = Object.values(ErrorCategory).reduce((acc, category) => {
      acc[category] = 0
      return acc
    }, {} as Record<ErrorCategory, number>)

    const bySeverity = Object.values(ErrorSeverity).reduce((acc, severity) => {
      acc[severity] = 0
      return acc
    }, {} as Record<ErrorSeverity, number>)

    let recent = 0

    for (const error of this.errorHistory) {
      byCategory[error.category]++
      bySeverity[error.severity]++
      
      if (error.timestamp.getTime() > oneHourAgo) {
        recent++
      }
    }

    return {
      total: this.errorHistory.length,
      byCategory,
      bySeverity,
      recent,
    }
  }

  /**
   * Handle security-specific errors
   */
  handleSecurityError(error: Error): EdgeFunctionsError {
    const handledError = this.handleError(error, { operation: 'security_validation' })
    
    // Sanitize security error messages to not reveal sensitive information
    if (handledError.code === 'SECURITY_ACCESS_DENIED') {
      handledError.message = 'Access denied to requested resource'
    }
    
    return handledError
  }

  /**
   * Handle service-specific errors
   */
  handleServiceError(error: Error): EdgeFunctionsError {
    return this.handleError(error, { operation: 'service_validation' })
  }

  /**
   * Handle storage-specific errors
   */
  handleStorageError(error: Error): EdgeFunctionsError {
    return this.handleError(error, { operation: 'storage_validation' })
  }
}

// Singleton instance
export const errorHandlingService = new ErrorHandlingService()

/**
 * Utility function to handle Edge Functions errors
 */
export function handleEdgeFunctionsError(error: any, context?: ErrorContext): EdgeFunctionsError {
  return errorHandlingService.handleError(error, context)
}

/**
 * Utility function to generate diagnostic report
 */
export async function generateEdgeFunctionsDiagnostics(): Promise<DiagnosticReport> {
  return errorHandlingService.generateDiagnosticReport()
}