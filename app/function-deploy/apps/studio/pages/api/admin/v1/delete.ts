import type { NextApiRequest, NextApiResponse } from 'next'
import { withClusterAuth, type ClusterApiContext } from 'lib/cluster-management/cluster-api-wrapper'
import type { AuthenticatedRequest } from 'lib/cluster-management/auth-middleware'
import { ClusterManagementService } from 'lib/cluster-management/cluster-management-service'
import { DefaultClusterRepository } from 'lib/cluster-management/cluster-repository'
import { logClusterDeletion } from 'lib/cluster-management/audit-logger'

/**
 * DELETE /admin/v1/delete
 * 
 * Remove a cluster from management
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */
async function deleteClusterHandler(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  context: ClusterApiContext
) {
  const { method } = req

  if (method !== 'DELETE') {
    res.setHeader('Allow', ['DELETE'])
    return res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `Method ${method} not allowed`,
      },
    })
  }

  try {
    const { identifier, delete_secret = false } = req.body

    // Validate required fields
    if (!identifier) {
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

    // Delete the cluster
    await service.deleteCluster(identifier, delete_secret, connectionString)

    // Log the successful deletion
    await logClusterDeletion(
      context.user,
      identifier,
      context.organizationSlug || 'unknown',
      req
    )

    // Return confirmation
    return res.status(200).json({
      message: 'Cluster deleted successfully',
      identifier,
    })
  } catch (error) {
    console.error('Cluster deletion error:', error)

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

      if (error.message.includes('has') && error.message.includes('active databases')) {
        return res.status(400).json({
          error: {
            code: 'CLUSTER_HAS_ACTIVE_DATABASES',
            message: error.message,
          },
        })
      }
    }

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete cluster',
      },
    })
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return withClusterAuth(req, res, deleteClusterHandler, {
    requireOrganization: false,
    action: 'cluster.delete',
    resourceType: 'cluster',
  })
}
