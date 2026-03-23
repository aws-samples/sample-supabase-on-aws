import type { NextApiRequest, NextApiResponse } from 'next'
import { withClusterAuth, type ClusterApiContext } from 'lib/cluster-management/cluster-api-wrapper'
import type { AuthenticatedRequest } from 'lib/cluster-management/auth-middleware'
import { DefaultAllocationStrategyRepository } from 'lib/cluster-management/allocation-strategy-repository'
import { logStrategyUpdate } from 'lib/cluster-management/audit-logger'

/**
 * POST /admin/v1/strategy - Create or update an allocation strategy
 * GET /admin/v1/strategy - Retrieve allocation strategies
 * 
 * Requirements: 7.1, 7.2
 */
async function strategyHandler(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  context: ClusterApiContext
) {
  const { method } = req

  if (method === 'GET') {
    return handleGet(req, res, context)
  } else if (method === 'POST') {
    return handlePost(req, res, context)
  } else if (method === 'DELETE') {
    return handleDelete(req, res, context)
  } else {
    res.setHeader('Allow', ['GET', 'POST', 'DELETE'])
    return res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `Method ${method} not allowed`,
      },
    })
  }
}

/**
 * GET handler - Retrieve allocation strategies
 */
async function handleGet(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  context: ClusterApiContext
) {
  try {
    const { name, projectRef, connectionString } = req.query

    // Validate required fields
    if (!projectRef || !connectionString) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields',
          details: {
            required: ['projectRef', 'connectionString'],
          },
        },
      })
    }

    // Initialize repository
    const repository = new DefaultAllocationStrategyRepository()

    // If name is provided, get specific strategy; otherwise get all
    if (name) {
      const strategy = await repository.findByName(
        name as string,
        projectRef as string,
        connectionString as string
      )

      if (!strategy) {
        return res.status(404).json({
          error: {
            code: 'STRATEGY_NOT_FOUND',
            message: `Strategy with name '${name}' not found`,
          },
        })
      }

      return res.status(200).json(strategy)
    } else {
      const strategies = await repository.findAll(
        projectRef as string,
        connectionString as string
      )

      return res.status(200).json({
        strategies,
        count: strategies.length,
      })
    }
  } catch (error) {
    console.error('Strategy retrieval error:', error)

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to retrieve strategies',
      },
    })
  }
}

/**
 * POST handler - Create or update an allocation strategy
 */
async function handlePost(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  context: ClusterApiContext
) {

  try {
    const {
      name,
      strategy_type,
      description = null,
      config = null,
      is_active = false,
      projectRef,
      connectionString,
    } = req.body

    // Validate required fields
    if (!name || !strategy_type || !projectRef || !connectionString) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields',
          details: {
            required: ['name', 'strategy_type', 'projectRef', 'connectionString'],
          },
        },
      })
    }

    // Validate strategy_type (Requirement 7.1)
    const validStrategyTypes = ['manual', 'hash', 'round_robin', 'weighted_round_robin', 'least_connections']
    if (!validStrategyTypes.includes(strategy_type)) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid strategy_type',
          details: {
            strategy_type: `Must be one of: ${validStrategyTypes.join(', ')}`,
          },
        },
      })
    }

    // Initialize repository
    const repository = new DefaultAllocationStrategyRepository()

    // Upsert the strategy (Requirement 7.2)
    const strategy = await repository.upsert(
      {
        name,
        strategy_type,
        description,
        config,
        is_active,
      },
      projectRef,
      connectionString
    )

    // Log the successful action
    await logStrategyUpdate(
      context.user,
      strategy.name,
      strategy.strategy_type,
      context.organizationSlug || 'unknown',
      req
    )

    // Return the created/updated strategy
    return res.status(200).json({
      id: strategy.id,
      name: strategy.name,
      strategy_type: strategy.strategy_type,
      description: strategy.description,
      config: strategy.config,
      is_active: strategy.is_active,
      created_at: strategy.created_at,
      updated_at: strategy.updated_at,
    })
  } catch (error) {
    console.error('Strategy update error:', error)

    // Handle specific error cases
    if (error instanceof Error) {
      if (error.message.includes('duplicate') || error.message.includes('unique')) {
        return res.status(409).json({
          error: {
            code: 'DUPLICATE_STRATEGY_NAME',
            message: 'A strategy with this name already exists',
          },
        })
      }
    }

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create or update strategy',
      },
    })
  }
}

/**
 * DELETE handler - Delete an allocation strategy
 */
async function handleDelete(
  req: AuthenticatedRequest,
  res: NextApiResponse,
  context: ClusterApiContext
) {
  try {
    const { name, projectRef, connectionString } = req.body

    // Validate required fields
    if (!name || !projectRef || !connectionString) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields',
          details: {
            required: ['name', 'projectRef', 'connectionString'],
          },
        },
      })
    }

    // Initialize repository
    const repository = new DefaultAllocationStrategyRepository()

    // Check if strategy exists
    const strategy = await repository.findByName(name, projectRef, connectionString)
    if (!strategy) {
      return res.status(404).json({
        error: {
          code: 'STRATEGY_NOT_FOUND',
          message: `Strategy with name '${name}' not found`,
        },
      })
    }

    // Prevent deletion of active strategy
    if (strategy.is_active) {
      return res.status(400).json({
        error: {
          code: 'CANNOT_DELETE_ACTIVE_STRATEGY',
          message: 'Cannot delete the active strategy. Please activate another strategy first.',
        },
      })
    }

    // Delete the strategy
    await repository.delete(name, projectRef, connectionString)

    // Log the successful action
    await logStrategyUpdate(
      context.user,
      name,
      'deleted',
      context.organizationSlug || 'unknown',
      req
    )

    return res.status(200).json({
      message: 'Strategy deleted successfully',
    })
  } catch (error) {
    console.error('Strategy deletion error:', error)

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete strategy',
      },
    })
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return withClusterAuth(req, res, strategyHandler, {
    requireOrganization: false,
    action: 'strategy.update',
    resourceType: 'allocation_strategy',
  })
}
