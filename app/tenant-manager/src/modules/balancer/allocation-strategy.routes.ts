/**
 * Allocation strategy CRUD routes
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createAuthPreHandler } from '../../common/middleware/auth.middleware.js'
import { validateBody, validateParams } from '../../common/validation/middleware.js'
import { createStrategySchema, updateStrategySchema, strategyNameSchema } from './allocation-strategy.schema.js'
import {
  findAllStrategies,
  findStrategyByName,
  insertStrategy,
  updateStrategyByName,
  deleteStrategyByName,
  activateStrategy,
} from '../../db/repositories/allocation-strategy.repository.js'
import { NotFoundError, BadRequestError, ConflictError } from '../../common/errors/index.js'

export async function allocationStrategyRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandler = createAuthPreHandler()

  // List all strategies
  fastify.get(
    '/admin/v1/rds-allocation-strategies',
    {
      preHandler: [authPreHandler],
    },
    async (_request, _reply) => {
      const strategies = await findAllStrategies()
      return { data: strategies }
    }
  )

  // Create strategy
  fastify.post(
    '/admin/v1/rds-allocation-strategies',
    {
      preHandler: [authPreHandler, validateBody(createStrategySchema)],
    },
    async (request, reply) => {
      const input = request.body as z.infer<typeof createStrategySchema>

      const existing = await findStrategyByName(input.name)
      if (existing) {
        throw new ConflictError(`Strategy already exists: ${input.name}`)
      }

      const strategy = await insertStrategy({
        name: input.name,
        strategy_type: input.strategy_type,
        description: input.description ?? null,
        config: input.config ? JSON.stringify(input.config) : null,
        is_active: input.is_active,
      })

      return reply.status(201).send({ data: strategy })
    }
  )

  // Update strategy
  fastify.patch(
    '/admin/v1/rds-allocation-strategies/:name',
    {
      preHandler: [authPreHandler, validateParams(strategyNameSchema), validateBody(updateStrategySchema)],
    },
    async (request, _reply) => {
      const { name } = request.params as z.infer<typeof strategyNameSchema>
      const updates = request.body as z.infer<typeof updateStrategySchema>

      const updateData: Record<string, unknown> = {}
      if (updates['strategy_type'] !== undefined) updateData['strategy_type'] = updates['strategy_type']
      if (updates['description'] !== undefined) updateData['description'] = updates['description']
      if (updates['config'] !== undefined) updateData['config'] = JSON.stringify(updates['config'])
      if (updates['is_active'] !== undefined) updateData['is_active'] = updates['is_active']

      const strategy = await updateStrategyByName(name, updateData)
      if (!strategy) {
        throw new NotFoundError(`Strategy not found: ${name}`)
      }

      return { data: strategy }
    }
  )

  // Delete strategy
  fastify.delete(
    '/admin/v1/rds-allocation-strategies/:name',
    {
      preHandler: [authPreHandler, validateParams(strategyNameSchema)],
    },
    async (request, reply) => {
      const { name } = request.params as z.infer<typeof strategyNameSchema>

      const existing = await findStrategyByName(name)
      if (!existing) {
        throw new NotFoundError(`Strategy not found: ${name}`)
      }

      if (existing.is_active) {
        throw new BadRequestError('Cannot delete an active strategy. Activate another strategy first.')
      }

      await deleteStrategyByName(name)
      return reply.status(204).send()
    }
  )

  // Activate strategy
  fastify.post(
    '/admin/v1/rds-allocation-strategies/:name/activate',
    {
      preHandler: [authPreHandler, validateParams(strategyNameSchema)],
    },
    async (request, _reply) => {
      const { name } = request.params as z.infer<typeof strategyNameSchema>

      const strategy = await activateStrategy(name)
      if (!strategy) {
        throw new NotFoundError(`Strategy not found: ${name}`)
      }

      return { data: strategy }
    }
  )
}
