import type { NextApiRequest, NextApiResponse } from 'next'
import { withClusterAuth, type ClusterApiContext } from 'lib/cluster-management/cluster-api-wrapper'
import type { AuthenticatedRequest } from 'lib/cluster-management/auth-middleware'
import { ClusterManagementService } from 'lib/cluster-management/cluster-management-service'
import { DefaultClusterRepository } from 'lib/cluster-management/cluster-repository'
import { logClusterRegistration } from 'lib/cluster-management/audit-logger'

/**
 * POST /admin/v1/add
 * 
 * Register a new database cluster
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */
async function addClusterHandler(
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
    const {
      identifier,
      name,
      host,
      port = 5432,
      admin_user = 'postgres',
      auth_method = 'password',
      credential,
      region = 'default',
      weight = 100,
      max_databases = 100,
      is_management_instance = false,
    } = req.body

    // Validate required fields
    if (!identifier || !name || !host || !credential) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields',
          details: {
            required: ['identifier', 'name', 'host', 'credential'],
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

    // Validate auth_method
    if (!['password', 'secrets_manager'].includes(auth_method)) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid auth_method',
          details: {
            auth_method: 'Must be one of: password, secrets_manager',
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

    // Register the cluster
    const cluster = await service.registerCluster(
      {
        identifier,
        name,
        host,
        port,
        admin_user,
        auth_method,
        credential,
        region,
        weight,
        max_databases,
        is_management_instance,
      },
      connectionString
    )

    // Log the successful registration
    await logClusterRegistration(
      context.user,
      cluster.identifier,
      context.organizationSlug || 'unknown',
      req
    )

    // Return cluster without exposing credentials (Requirement 4.6)
    return res.status(201).json({
      id: cluster.id,
      identifier: cluster.identifier,
      name: cluster.name,
      host: cluster.host,
      port: cluster.port,
      admin_user: cluster.admin_user,
      auth_method: cluster.auth_method,
      region: cluster.region,
      status: cluster.status,
      weight: cluster.weight,
      max_databases: cluster.max_databases,
      current_databases: cluster.current_databases,
      created_at: cluster.created_at,
    })
  } catch (error) {
    console.error('Cluster registration error:', error)

    // Handle specific error cases
    if (error instanceof Error) {
      if (error.message.includes('already exists')) {
        return res.status(409).json({
          error: {
            code: 'DUPLICATE_IDENTIFIER',
            message: error.message,
          },
        })
      }

      if (error.message.includes('Invalid secret reference')) {
        return res.status(400).json({
          error: {
            code: 'INVALID_SECRET_REFERENCE',
            message: error.message,
          },
        })
      }

      if (error.message.includes('Required field')) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: error.message,
          },
        })
      }
    }

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to register cluster',
      },
    })
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return withClusterAuth(req, res, addClusterHandler, {
    requireOrganization: false,
    action: 'cluster.register',
    resourceType: 'cluster',
  })
}
