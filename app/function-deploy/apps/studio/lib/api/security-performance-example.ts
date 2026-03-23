/**
 * Example usage of security and performance optimizations
 * 
 * This file demonstrates how to use the integrated security validations,
 * performance optimizations, and audit logging in real API endpoints.
 */

import { NextApiRequest, NextApiResponse } from 'next'
import { 
  createIntegratedApiHandler,
  createSecureDataService,
  performanceMonitoringMiddleware,
  securityHeadersMiddleware
} from './security-performance-integration'
import { AuditEventType } from './audit-logging'
import { getAuditLogger } from './audit-logging'

/**
 * Example: Secure monitoring data API endpoint
 */
export const monitoringDataHandler = createIntegratedApiHandler({
  requiredPermission: 'canViewMonitoring',
  enableCaching: true,
  cacheConfig: {
    ttl: 300, // 5 minutes
    keyPrefix: 'monitoring'
  },
  auditEvent: AuditEventType.DATA_ACCESSED,
  queryOptimization: {
    enablePagination: true,
    limit: 50,
    orderBy: 'timestamp',
    orderDirection: 'DESC'
  }
})(async (req, res, context) => {
  // This handler automatically gets:
  // - Security validation (user authentication, project access, permissions)
  // - Query optimization and caching
  // - Audit logging
  // - Performance monitoring
  
  const { projectId, userId, permissions } = context
  
  // Mock monitoring data - in real implementation, this would query the database
  const monitoringData = [
    {
      id: 1,
      projectId,
      metricName: 'cpu_usage',
      metricValue: 45.2,
      timestamp: new Date()
    },
    {
      id: 2,
      projectId,
      metricName: 'memory_usage',
      metricValue: 67.8,
      timestamp: new Date()
    }
  ]

  return {
    data: monitoringData,
    total: monitoringData.length,
    permissions: {
      canExport: permissions.canAdmin,
      canModify: permissions.canWrite
    }
  }
})

/**
 * Example: Secure project deletion API endpoint
 */
export const projectDeletionHandler = createIntegratedApiHandler({
  requiredPermission: 'canDelete',
  enableCaching: false, // Don't cache deletion operations
  auditEvent: AuditEventType.PROJECT_DELETE_ATTEMPTED
})(async (req, res, context) => {
  const { projectId, projectRef, userId } = context
  
  // Validate deletion confirmation
  const { confirmationName } = req.body
  if (confirmationName !== projectRef) {
    throw new Error('Project name confirmation does not match')
  }

  // Log the deletion attempt with high severity
  const auditLogger = getAuditLogger()
  await auditLogger.logProjectOperation(
    AuditEventType.PROJECT_DELETED,
    projectId,
    projectRef,
    userId,
    {
      confirmationProvided: confirmationName,
      deletionReason: req.body.reason || 'User requested',
      ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress
    },
    true
  )

  // Mock project deletion - in real implementation, this would delete from database
  console.log(`Project ${projectRef} (ID: ${projectId}) deleted by user ${userId}`)

  return {
    success: true,
    message: `Project ${projectRef} has been successfully deleted`,
    deletedAt: new Date().toISOString()
  }
})

/**
 * Example: Secure data service with integrated logging
 */
class BaseMonitoringService {
  async getMetrics(projectId: number, filters: any = {}) {
    // Mock implementation
    await new Promise(resolve => setTimeout(resolve, 100)) // Simulate DB query
    
    return [
      { id: 1, projectId, name: 'cpu', value: 45.2 },
      { id: 2, projectId, name: 'memory', value: 67.8 }
    ]
  }

  async createMetric(projectId: number, metric: any) {
    // Mock implementation
    await new Promise(resolve => setTimeout(resolve, 50))
    
    return {
      id: Date.now(),
      projectId,
      ...metric,
      createdAt: new Date()
    }
  }

  async deleteMetric(projectId: number, metricId: number) {
    // Mock implementation
    await new Promise(resolve => setTimeout(resolve, 30))
    
    return { success: true, deletedId: metricId }
  }
}

// Create secure version of the service with automatic audit logging
export const secureMonitoringService = createSecureDataService(
  'MonitoringService',
  new BaseMonitoringService()
)

/**
 * Example: API middleware setup for an endpoint
 */
export function setupSecureEndpoint(handler: any) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    // Apply security headers
    securityHeadersMiddleware()(req, res, () => {
      // Apply performance monitoring
      performanceMonitoringMiddleware()(req, res, () => {
        // Execute the actual handler
        handler(req, res)
      })
    })
  }
}

/**
 * Example: Health check endpoint with integrated monitoring
 */
export const healthCheckEndpoint = setupSecureEndpoint(
  createIntegratedApiHandler({
    requiredPermission: 'canRead',
    enableCaching: true,
    cacheConfig: { ttl: 60 }, // Cache for 1 minute
    auditEvent: AuditEventType.DATA_ACCESSED
  })(async (req, res, context) => {
    const auditLogger = getAuditLogger()
    
    // Get recent audit statistics
    const recentEvents = await auditLogger.queryLogs({ 
      limit: 10,
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
    })

    const errorEvents = recentEvents.filter(e => !e.success)
    
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      project: {
        id: context.projectId,
        ref: context.projectRef
      },
      user: {
        id: context.userId,
        permissions: Object.entries(context.permissions)
          .filter(([, value]) => value)
          .map(([key]) => key)
      },
      metrics: {
        totalAuditEvents: recentEvents.length,
        errorEvents: errorEvents.length,
        errorRate: recentEvents.length > 0 ? (errorEvents.length / recentEvents.length) * 100 : 0,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      }
    }
  })
)

/**
 * Example usage in a Next.js API route:
 * 
 * // pages/api/projects/[ref]/monitoring.ts
 * export default monitoringDataHandler
 * 
 * // pages/api/projects/[ref]/delete.ts  
 * export default projectDeletionHandler
 * 
 * // pages/api/health.ts
 * export default healthCheckEndpoint
 */

/**
 * Example usage of secure data service:
 * 
 * // In a component or API handler
 * const metrics = await secureMonitoringService.getMetrics(projectId, { 
 *   startDate: '2024-01-01',
 *   endDate: '2024-01-31'
 * })
 * 
 * // Automatically logs audit events:
 * // - Data access attempt
 * // - Success/failure status
 * // - Performance metrics
 * // - User and project context
 */