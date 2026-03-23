/**
 * Startup Validation for Edge Functions
 * 
 * Provides startup validation hooks and initialization checks
 * for Edge Functions configuration and services.
 */

import { configurationValidationService, type ValidationResult } from './ConfigurationValidationService'
import { errorHandlingService, type DiagnosticReport } from './ErrorHandlingService'
import { platformDetectionService } from '../platform-detection'

export interface StartupValidationResult {
  success: boolean
  validation: ValidationResult
  diagnostics?: DiagnosticReport
  criticalErrors: string[]
  warnings: string[]
  recommendations: string[]
}

/**
 * Perform comprehensive startup validation for Edge Functions
 */
export async function performStartupValidation(): Promise<StartupValidationResult> {
  console.log('🔍 Performing Edge Functions startup validation...')
  
  try {
    // Validate configuration
    const validation = await configurationValidationService.validateConfiguration()
    
    // Generate diagnostics if there are issues
    let diagnostics: DiagnosticReport | undefined
    if (!validation.valid || validation.warnings.length > 0) {
      diagnostics = await errorHandlingService.generateDiagnosticReport()
    }
    
    // Collect critical errors and warnings
    const criticalErrors = validation.errors
      .filter(error => ['MISSING_AWS_CREDENTIALS', 'SERVICE_UNAVAILABLE', 'INVALID_STORAGE_BACKEND'].includes(error.code))
      .map(error => error.message)
    
    const warnings = validation.warnings.map(warning => warning.message)
    
    // Generate recommendations
    const recommendations = generateStartupRecommendations(validation, diagnostics)
    
    const success = validation.valid && criticalErrors.length === 0
    
    // Log results
    if (success) {
      console.log('✅ Edge Functions startup validation passed')
      if (warnings.length > 0) {
        console.warn(`⚠️  ${warnings.length} warning(s) found:`)
        warnings.forEach(warning => console.warn(`   - ${warning}`))
      }
    } else {
      console.error('❌ Edge Functions startup validation failed')
      if (criticalErrors.length > 0) {
        console.error(`🚨 ${criticalErrors.length} critical error(s):`)
        criticalErrors.forEach(error => console.error(`   - ${error}`))
      }
    }
    
    return {
      success,
      validation,
      diagnostics,
      criticalErrors,
      warnings,
      recommendations,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during startup validation'
    console.error('❌ Startup validation failed:', errorMessage)
    
    return {
      success: false,
      validation: {
        valid: false,
        errors: [{
          code: 'STARTUP_VALIDATION_ERROR',
          message: errorMessage,
          suggestions: [
            'Check system resources and dependencies',
            'Review application logs for more details',
            'Ensure all required services are running',
          ],
        }],
        warnings: [],
        config: configurationValidationService['parseConfiguration'](),
      },
      criticalErrors: [errorMessage],
      warnings: [],
      recommendations: [
        'Review system configuration and dependencies',
        'Check Docker container status and logs',
        'Verify environment variables are set correctly',
      ],
    }
  }
}

/**
 * Generate startup recommendations based on validation results
 */
function generateStartupRecommendations(
  validation: ValidationResult,
  diagnostics?: DiagnosticReport
): string[] {
  const recommendations: string[] = []
  
  // Configuration recommendations
  if (!validation.valid) {
    recommendations.push('Review and fix configuration errors before proceeding')
  }
  
  if (validation.config.storageBackend === 's3' && !platformDetectionService.isPlatform()) {
    recommendations.push('Consider using local storage for development environments')
  }
  
  // Service recommendations
  if (diagnostics) {
    if (diagnostics.services.edgeFunctions.status !== 'healthy') {
      recommendations.push('Ensure Edge Functions Docker container is running and accessible')
    }
    
    if (diagnostics.services.storage.status !== 'healthy') {
      recommendations.push('Verify storage backend configuration and connectivity')
    }
    
    if (diagnostics.connectivity.responseTime && diagnostics.connectivity.responseTime > 3000) {
      recommendations.push('Consider optimizing service response times for better performance')
    }
  }
  
  // Environment-specific recommendations
  if (!platformDetectionService.isPlatform()) {
    recommendations.push('Review self-hosted deployment documentation for best practices')
    
    if (validation.config.storageBackend === 'local') {
      recommendations.push('Ensure proper backup strategy for local function storage')
    }
  }
  
  // Security recommendations
  if (validation.config.enableUserIsolation) {
    recommendations.push('Verify user isolation middleware is properly configured')
  }
  
  return recommendations
}

/**
 * Validate Edge Functions readiness for production
 */
export async function validateProductionReadiness(): Promise<{
  ready: boolean
  issues: string[]
  recommendations: string[]
}> {
  const validation = await configurationValidationService.validateConfiguration()
  const diagnostics = await errorHandlingService.generateDiagnosticReport()
  
  const issues: string[] = []
  const recommendations: string[] = []
  
  // Check for production-critical issues
  if (!validation.valid) {
    issues.push('Configuration validation failed')
    recommendations.push('Fix all configuration errors before production deployment')
  }
  
  if (diagnostics.services.edgeFunctions.status !== 'healthy') {
    issues.push('Edge Functions service is not healthy')
    recommendations.push('Ensure Edge Functions service is running and accessible')
  }
  
  if (diagnostics.services.storage.status !== 'healthy') {
    issues.push('Storage backend is not accessible')
    recommendations.push('Verify storage backend configuration and connectivity')
  }
  
  // Production-specific checks
  if (validation.config.storageBackend === 's3') {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      issues.push('AWS credentials not configured for S3 storage')
      recommendations.push('Configure AWS credentials for production S3 access')
    }
  }
  
  if (!validation.config.enableUserIsolation) {
    issues.push('User isolation is disabled')
    recommendations.push('Enable user isolation for production security')
  }
  
  // Performance checks
  if (diagnostics.connectivity.responseTime && diagnostics.connectivity.responseTime > 5000) {
    issues.push('Service response time is too slow for production')
    recommendations.push('Optimize service performance before production deployment')
  }
  
  return {
    ready: issues.length === 0,
    issues,
    recommendations,
  }
}

/**
 * Quick health check for Edge Functions
 */
export async function quickHealthCheck(): Promise<{
  healthy: boolean
  status: string
  details?: Record<string, any>
}> {
  try {
    const [serviceStatus, configValid] = await Promise.all([
      platformDetectionService.validateLocalServices(),
      configurationValidationService.validateConfiguration(),
    ])
    
    const healthy = serviceStatus.available && configValid.valid
    const status = healthy ? 'healthy' : 'unhealthy'
    
    return {
      healthy,
      status,
      details: {
        serviceAvailable: serviceStatus.available,
        configurationValid: configValid.valid,
        endpoint: serviceStatus.endpoint,
        errorCount: configValid.errors.length,
        warningCount: configValid.warnings.length,
      },
    }
  } catch (error) {
    return {
      healthy: false,
      status: 'error',
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    }
  }
}

/**
 * Initialize Edge Functions with validation
 */
export async function initializeEdgeFunctions(): Promise<StartupValidationResult> {
  console.log('🚀 Initializing Edge Functions...')
  
  // Clear any cached validation results
  configurationValidationService.clearCache()
  
  // Perform startup validation
  const result = await performStartupValidation()
  
  if (result.success) {
    console.log('✅ Edge Functions initialized successfully')
  } else {
    console.error('❌ Edge Functions initialization failed')
    
    // Log recommendations
    if (result.recommendations.length > 0) {
      console.log('💡 Recommendations:')
      result.recommendations.forEach(rec => console.log(`   - ${rec}`))
    }
  }
  
  return result
}