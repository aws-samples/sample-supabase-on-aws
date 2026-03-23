import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest } from 'next'

/**
 * Audit log entry for cluster management actions
 */
export interface ClusterAuditLog {
  timestamp: string
  user_id: string
  user_email?: string
  action: string
  resource_type: 'cluster' | 'allocation_strategy'
  resource_id?: string
  organization_slug?: string
  metadata?: Record<string, any>
  ip_address?: string
  user_agent?: string
  status: 'success' | 'failure'
  error_message?: string
}

/**
 * Audit logger for cluster management operations.
 * Logs all administrative actions with user identity and timestamp.
 * 
 * Requirements: 13.5
 */
export class ClusterAuditLogger {
  /**
   * Log a cluster management action
   * 
   * @param params - Audit log parameters
   */
  static async logAction(params: {
    user: JwtPayload
    action: string
    resourceType: 'cluster' | 'allocation_strategy'
    resourceId?: string
    organizationSlug?: string
    metadata?: Record<string, any>
    req?: NextApiRequest
    status: 'success' | 'failure'
    errorMessage?: string
  }): Promise<void> {
    const {
      user,
      action,
      resourceType,
      resourceId,
      organizationSlug,
      metadata,
      req,
      status,
      errorMessage,
    } = params

    const auditLog: ClusterAuditLog = {
      timestamp: new Date().toISOString(),
      user_id: user.sub || 'unknown',
      user_email: user.email,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      organization_slug: organizationSlug,
      metadata: this.sanitizeMetadata(metadata),
      ip_address: this.extractIpAddress(req),
      user_agent: req?.headers['user-agent'],
      status,
      error_message: errorMessage,
    }

    // Log to console (in production, this would be sent to a logging service)
    console.log('[CLUSTER_AUDIT]', JSON.stringify(auditLog))

    // TODO: In production, send to audit log storage/service
    // This could be:
    // - Database table for audit logs
    // - External logging service (e.g., CloudWatch, Datadog)
    // - Message queue for async processing
  }

  /**
   * Log a successful cluster management action
   */
  static async logSuccess(params: {
    user: JwtPayload
    action: string
    resourceType: 'cluster' | 'allocation_strategy'
    resourceId?: string
    organizationSlug?: string
    metadata?: Record<string, any>
    req?: NextApiRequest
  }): Promise<void> {
    await this.logAction({ ...params, status: 'success' })
  }

  /**
   * Log a failed cluster management action
   */
  static async logFailure(params: {
    user: JwtPayload
    action: string
    resourceType: 'cluster' | 'allocation_strategy'
    resourceId?: string
    organizationSlug?: string
    metadata?: Record<string, any>
    req?: NextApiRequest
    errorMessage: string
  }): Promise<void> {
    await this.logAction({ ...params, status: 'failure' })
  }

  /**
   * Sanitize metadata to remove sensitive information
   */
  private static sanitizeMetadata(
    metadata?: Record<string, any>
  ): Record<string, any> | undefined {
    if (!metadata) return undefined

    const sanitized = { ...metadata }

    // Remove sensitive fields
    const sensitiveFields = [
      'password',
      'credential',
      'admin_credential',
      'secret',
      'token',
      'api_key',
    ]

    for (const field of sensitiveFields) {
      if (field in sanitized) {
        sanitized[field] = '***REDACTED***'
      }
    }

    return sanitized
  }

  /**
   * Extract IP address from request
   */
  private static extractIpAddress(req?: NextApiRequest): string | undefined {
    if (!req) return undefined

    // Check common headers for IP address
    const ipHeaders = [
      'x-real-ip',
      'x-forwarded-for',
      'cf-connecting-ip', // Cloudflare
      'x-client-ip',
    ]

    for (const header of ipHeaders) {
      const value = req.headers[header]
      if (value) {
        // x-forwarded-for can contain multiple IPs, take the first one
        const ip = Array.isArray(value) ? value[0] : value
        return ip.split(',')[0].trim()
      }
    }

    return undefined
  }
}

/**
 * Convenience functions for common cluster management actions
 */

export async function logClusterRegistration(
  user: JwtPayload,
  clusterId: string,
  organizationSlug: string,
  req?: NextApiRequest
): Promise<void> {
  await ClusterAuditLogger.logSuccess({
    user,
    action: 'cluster.register',
    resourceType: 'cluster',
    resourceId: clusterId,
    organizationSlug,
    req,
  })
}

export async function logClusterOnline(
  user: JwtPayload,
  clusterId: string,
  organizationSlug: string,
  req?: NextApiRequest
): Promise<void> {
  await ClusterAuditLogger.logSuccess({
    user,
    action: 'cluster.online',
    resourceType: 'cluster',
    resourceId: clusterId,
    organizationSlug,
    req,
  })
}

export async function logClusterOffline(
  user: JwtPayload,
  clusterId: string,
  organizationSlug: string,
  req?: NextApiRequest
): Promise<void> {
  await ClusterAuditLogger.logSuccess({
    user,
    action: 'cluster.offline',
    resourceType: 'cluster',
    resourceId: clusterId,
    organizationSlug,
    req,
  })
}

export async function logClusterDeletion(
  user: JwtPayload,
  clusterId: string,
  organizationSlug: string,
  req?: NextApiRequest
): Promise<void> {
  await ClusterAuditLogger.logSuccess({
    user,
    action: 'cluster.delete',
    resourceType: 'cluster',
    resourceId: clusterId,
    organizationSlug,
    req,
  })
}

export async function logCapacityUpdate(
  user: JwtPayload,
  clusterId: string,
  oldCapacity: number,
  newCapacity: number,
  organizationSlug: string,
  req?: NextApiRequest
): Promise<void> {
  await ClusterAuditLogger.logSuccess({
    user,
    action: 'cluster.capacity_update',
    resourceType: 'cluster',
    resourceId: clusterId,
    organizationSlug,
    metadata: {
      old_capacity: oldCapacity,
      new_capacity: newCapacity,
    },
    req,
  })
}

export async function logStrategyUpdate(
  user: JwtPayload,
  strategyName: string,
  strategyType: string,
  organizationSlug: string,
  req?: NextApiRequest
): Promise<void> {
  await ClusterAuditLogger.logSuccess({
    user,
    action: 'strategy.update',
    resourceType: 'allocation_strategy',
    resourceId: strategyName,
    organizationSlug,
    metadata: {
      strategy_type: strategyType,
    },
    req,
  })
}
