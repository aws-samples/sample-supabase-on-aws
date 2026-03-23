import type { NextApiRequest, NextApiResponse } from 'next'
import { withClusterAuth, type ClusterApiContext } from 'lib/cluster-management/cluster-api-wrapper'
import type { AuthenticatedRequest } from 'lib/cluster-management/auth-middleware'
import { ClusterManagementService } from 'lib/cluster-management/cluster-management-service'
import { DefaultClusterRepository } from 'lib/cluster-management/cluster-repository'

/**
 * GET /admin/v1/status
 * 
 * Retrieve cluster status and metrics
 * 
 * Requirements: 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3
 */
async function statusHandler(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  context: ClusterApiContext
) {
  const { method } = req

  if (method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `Method ${method} not allowed`,
      },
    })
  }

  try {
    const { region, status } = req.query

    // Construct connection string from environment variables on the server side
    const connectionString = process.env.DATABASE_URL || 
      `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || 5432}/${process.env.POSTGRES_DB || 'postgres'}`

    if (!connectionString) {
      return res.status(500).json({
        error: {
          code: 'CONFIGURATION_ERROR',
          message: 'Database connection not configured',
        },
      })
    }

    // Validate status if provided
    if (status && !['online', 'offline', 'maintenance'].includes(status as string)) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid status value',
          details: {
            status: 'Must be one of: online, offline, maintenance',
          },
        },
      })
    }

    // Initialize service
    const repository = new DefaultClusterRepository()
    const encryptionKey = process.env.CLUSTER_ENCRYPTION_KEY || 'default-encryption-key-change-in-production'
    const service = new ClusterManagementService(repository, encryptionKey, {
      region: process.env.AWS_REGION,
      maxRetries: 3,
    })

    // Get cluster status with filters
    const filters: { region?: string; status?: string } = {}
    if (region) filters.region = region as string
    if (status) filters.status = status as string

    const response = await service.getClusterStatus(
      connectionString,
      filters
    )

    // Mask credentials in response (Requirement 4.6, 14.5)
    const clustersWithoutCredentials = response.clusters.map((cluster) => ({
      identifier: cluster.identifier,
      name: cluster.name,
      host: cluster.host,
      port: cluster.port,
      region: cluster.region,
      status: cluster.status,
      auth_method: cluster.auth_method,
      weight: cluster.weight,
      max_databases: cluster.max_databases,
      current_databases: cluster.current_databases,
      utilization_percentage: cluster.utilization_percentage,
      created_at: cluster.created_at,
      updated_at: cluster.updated_at,
    }))

    // Return clusters with metrics and platform summary
    return res.status(200).json({
      clusters: clustersWithoutCredentials,
      summary: response.summary,
    })
  } catch (error) {
    console.error('Status query error:', error)

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to retrieve cluster status',
      },
    })
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return withClusterAuth(req, res, statusHandler, {
    requireOrganization: false,
    action: 'cluster.status_query',
    resourceType: 'cluster',
  })
}
