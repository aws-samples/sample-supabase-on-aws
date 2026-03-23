import type { NextApiRequest, NextApiResponse } from 'next'
import { withClusterAuth, type ClusterApiContext } from 'lib/cluster-management/cluster-api-wrapper'
import type { AuthenticatedRequest } from 'lib/cluster-management/auth-middleware'
import { ClusterManagementService } from 'lib/cluster-management/cluster-management-service'
import { DefaultClusterRepository } from 'lib/cluster-management/cluster-repository'
import { logCapacityUpdate } from 'lib/cluster-management/audit-logger'

/**
 * POST /admin/v1/capacity - Update cluster capacity limits
 * GET /admin/v1/capacity - Retrieve cluster capacity information
 * 
 * Requirements: 8.1, 8.2, 8.3
 */
async function capacityHandler(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  context: ClusterApiContext
) {
  const { method } = req

  if (method === 'GET') {
    return handleGet(req, res, context)
  } else if (method === 'POST') {
    return handlePost(req, res, context)
  } else {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `Method ${method} not allowed`,
      },
    })
  }
}

/**
 * GET handler - Retrieve cluster capacity information
 */
async function handleGet(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  context: ClusterApiContext
) {
  try {
    const { identifier } = req.query

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

    // Initialize repository
    const repository = new DefaultClusterRepository()

    // Get cluster
    const cluster = await repository.findByIdentifier(
      identifier as string,
      connectionString
    )

    if (!cluster) {
      return res.status(404).json({
        error: {
          code: 'CLUSTER_NOT_FOUND',
          message: `Cluster with identifier '${identifier}' not found`,
        },
      })
    }

    // Calculate utilization
    const utilizationPercentage = cluster.max_databases > 0
      ? (cluster.current_databases / cluster.max_databases) * 100
      : 0

    // Return capacity information
    return res.status(200).json({
      identifier: cluster.identifier,
      name: cluster.name,
      max_databases: cluster.max_databases,
      current_databases: cluster.current_databases,
      available_capacity: cluster.max_databases - cluster.current_databases,
      utilization_percentage: utilizationPercentage,
      status: cluster.status,
    })
  } catch (error) {
    console.error('Capacity retrieval error:', error)

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to retrieve cluster capacity',
      },
    })
  }
}

/**
 * POST handler - Update cluster capacity limits
 */
async function handlePost(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  context: ClusterApiContext
) {

  try {
    const { identifier, max_databases } = req.body

    // Validate required fields
    if (!identifier || max_databases === undefined) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields',
          details: {
            required: ['identifier', 'max_databases'],
          },
        },
      })
    }

    // Validate max_databases is a positive integer
    if (!Number.isInteger(max_databases) || max_databases <= 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'max_databases must be a positive integer',
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

    // Get current cluster to log old capacity
    const currentCluster = await repository.findByIdentifier(identifier, connectionString)
    if (!currentCluster) {
      return res.status(404).json({
        error: {
          code: 'CLUSTER_NOT_FOUND',
          message: `Cluster with identifier '${identifier}' not found`,
        },
      })
    }

    const oldCapacity = currentCluster.max_databases

    // Update capacity
    const cluster = await service.updateCapacity(identifier, max_databases, connectionString)

    // Calculate utilization
    const utilizationPercentage = cluster.max_databases > 0
      ? (cluster.current_databases / cluster.max_databases) * 100
      : 0

    // Log the successful action
    await logCapacityUpdate(
      context.user,
      cluster.identifier,
      oldCapacity,
      cluster.max_databases,
      context.organizationSlug || 'unknown',
      req
    )

    // Return updated cluster
    return res.status(200).json({
      identifier: cluster.identifier,
      max_databases: cluster.max_databases,
      current_databases: cluster.current_databases,
      utilization_percentage: utilizationPercentage,
      updated_at: cluster.updated_at,
    })
  } catch (error) {
    console.error('Capacity update error:', error)

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

      if (error.message.includes('must be greater than current_databases')) {
        return res.status(400).json({
          error: {
            code: 'INVALID_CAPACITY',
            message: error.message,
          },
        })
      }
    }

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update cluster capacity',
      },
    })
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return withClusterAuth(req, res, capacityHandler, {
    requireOrganization: false,
    action: 'cluster.capacity_update',
    resourceType: 'cluster',
  })
}
