import type { NextApiRequest, NextApiResponse } from 'next'
import { withClusterAuth, type ClusterApiContext } from 'lib/cluster-management/cluster-api-wrapper'
import type { AuthenticatedRequest } from 'lib/cluster-management/auth-middleware'
import { ClusterManagementService } from 'lib/cluster-management/cluster-management-service'
import { DefaultClusterRepository } from 'lib/cluster-management/cluster-repository'
import { logClusterOffline } from 'lib/cluster-management/audit-logger'

/**
 * POST /admin/v1/offline
 * 
 * Take a cluster offline (prevents new allocations)
 * 
 * Requirements: 5.2
 */
async function offlineClusterHandler(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  context: ClusterApiContext
) {
  const { method } = req

  if (method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `Method ${method} not allowed`,
      },
    })
  }

  try {
    const { identifier } = req.body

    // Validate required fields
    if (!identifier || typeof identifier !== 'string') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields',
          details: {
            required: ['identifier'],
          },
        },
      })
    }

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

    // Initialize service
    const repository = new DefaultClusterRepository()
    const encryptionKey = process.env.CLUSTER_ENCRYPTION_KEY || 'default-encryption-key-change-in-production'
    const service = new ClusterManagementService(repository, encryptionKey, {
      region: process.env.AWS_REGION,
      maxRetries: 3,
    })

    // Take cluster offline
    const cluster = await service.takeOffline(identifier, connectionString)

    // Log the successful action
    await logClusterOffline(
      context.user,
      cluster.identifier,
      context.organizationSlug || 'unknown',
      req
    )

    // Return updated cluster
    return res.status(200).json({
      identifier: cluster.identifier,
      status: cluster.status,
      updated_at: cluster.updated_at,
    })
  } catch (error) {
    console.error('Cluster offline error:', error)

    // Handle specific error cases
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: {
            code: 'CLUSTER_NOT_FOUND',
            message: error.message,
          },
        })
      }
    }

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to take cluster offline',
      },
    })
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return withClusterAuth(req, res, offlineClusterHandler, {
    requireOrganization: false,
    action: 'cluster.offline',
    resourceType: 'cluster',
  })
}
