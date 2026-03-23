/**
 * RDS instance management routes
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createAuthPreHandler } from '../../common/middleware/auth.middleware.js'
import { validateBody, validateQuery, validateParams } from '../../common/validation/middleware.js'
import { paginationSchema, instanceIdSchema } from '../../common/validation/schemas.js'
import { createInstanceSchema, updateInstanceSchema, listInstancesSchema } from './rds-instance.schemas.js'
import {
  listRdsInstances,
  getRdsInstancesCount,
  getRdsInstanceById,
  createRdsInstance,
  updateRdsInstance,
  deleteRdsInstance,
  setInstanceDraining,
  testInstanceCredentials,
} from './rds-instance.service.js'
import { listProjects, getProjectsCount } from '../project/project.service.js'
import { getInstanceLoadScores } from '../balancer/rds-balancer.service.js'
import { NotFoundError, BadRequestError, ConflictError } from '../../common/errors/index.js'

export async function rdsInstanceRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandler = createAuthPreHandler()

  // List RDS instances
  fastify.get(
    '/admin/v1/rds-instances',
    {
      preHandler: [authPreHandler, validateQuery(listInstancesSchema)],
    },
    async (request, _reply) => {
      const query = request.query as z.infer<typeof listInstancesSchema>
      const [instances, total] = await Promise.all([
        listRdsInstances(query),
        getRdsInstancesCount(query),
      ])

      return {
        data: instances.map((i) => ({
          ...i,
          admin_credential: undefined,
        })),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      }
    }
  )

  // Create RDS instance
  fastify.post(
    '/admin/v1/rds-instances',
    {
      preHandler: [authPreHandler, validateBody(createInstanceSchema)],
    },
    async (request, reply) => {
      const input = request.body as z.infer<typeof createInstanceSchema>
      const instance = await createRdsInstance(input)

      if (!instance) {
        throw new BadRequestError('Failed to create RDS instance. Identifier may already exist.')
      }

      return reply.status(201).send({
        data: {
          ...instance,
          admin_credential: undefined,
        },
      })
    }
  )

  // Get RDS instance by ID
  fastify.get(
    '/admin/v1/rds-instances/:id',
    {
      preHandler: [authPreHandler, validateParams(instanceIdSchema)],
    },
    async (request, _reply) => {
      const { id } = request.params as z.infer<typeof instanceIdSchema>
      const instance = await getRdsInstanceById(id)

      if (!instance) {
        throw new NotFoundError(`RDS instance not found: ${id}`)
      }

      return {
        data: {
          ...instance,
          admin_credential: undefined,
        },
      }
    }
  )

  // Update RDS instance
  fastify.patch(
    '/admin/v1/rds-instances/:id',
    {
      preHandler: [authPreHandler, validateParams(instanceIdSchema), validateBody(updateInstanceSchema)],
    },
    async (request, _reply) => {
      const { id } = request.params as z.infer<typeof instanceIdSchema>
      const updates = request.body as z.infer<typeof updateInstanceSchema>

      const instance = await updateRdsInstance(id, updates)

      if (!instance) {
        throw new NotFoundError(`RDS instance not found: ${id}`)
      }

      return {
        data: {
          ...instance,
          admin_credential: undefined,
        },
      }
    }
  )

  // Delete RDS instance
  fastify.delete(
    '/admin/v1/rds-instances/:id',
    {
      preHandler: [authPreHandler, validateParams(instanceIdSchema)],
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof instanceIdSchema>

      const instance = await getRdsInstanceById(id)
      if (!instance) {
        throw new NotFoundError(`RDS instance not found: ${id}`)
      }

      if (instance.is_management_instance) {
        throw new ConflictError('Cannot delete management instance')
      }

      if (instance.current_databases > 0) {
        throw new ConflictError('Cannot delete instance with existing databases. Migrate or delete projects first.')
      }

      const deleted = await deleteRdsInstance(id)

      if (!deleted) {
        throw new BadRequestError('Failed to delete RDS instance')
      }

      return reply.status(204).send()
    }
  )

  // Get RDS instance metrics / load scores
  fastify.get(
    '/admin/v1/rds-instances/:id/metrics',
    {
      preHandler: [authPreHandler, validateParams(instanceIdSchema)],
    },
    async (request, _reply) => {
      const { id } = request.params as z.infer<typeof instanceIdSchema>
      const instance = await getRdsInstanceById(id)

      if (!instance) {
        throw new NotFoundError(`RDS instance not found: ${id}`)
      }

      const allScores = await getInstanceLoadScores()
      const score = allScores.find((s) => s.instance.id === id)

      return {
        data: {
          instance_id: id,
          current_databases: instance.current_databases,
          max_databases: instance.max_databases,
          utilization_percent: (instance.current_databases / instance.max_databases) * 100,
          load_score: score?.score ?? null,
          score_details: score?.details ?? null,
        },
      }
    }
  )

  // List projects on an RDS instance
  fastify.get(
    '/admin/v1/rds-instances/:id/projects',
    {
      preHandler: [authPreHandler, validateParams(instanceIdSchema), validateQuery(paginationSchema)],
    },
    async (request, _reply) => {
      const { id } = request.params as z.infer<typeof instanceIdSchema>
      const query = request.query as z.infer<typeof paginationSchema>

      const instance = await getRdsInstanceById(id)
      if (!instance) {
        throw new NotFoundError(`RDS instance not found: ${id}`)
      }

      const [projects, total] = await Promise.all([
        listProjects({ ...query, db_instance_id: id }),
        getProjectsCount({ db_instance_id: id }),
      ])

      return {
        data: projects,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      }
    }
  )

  // Test credentials for an instance
  fastify.post(
    '/admin/v1/rds-instances/:id/test-credentials',
    {
      preHandler: [authPreHandler, validateParams(instanceIdSchema)],
    },
    async (request, _reply) => {
      const { id } = request.params as z.infer<typeof instanceIdSchema>
      const result = await testInstanceCredentials(id)

      if (!result.success && result.error === 'Instance not found') {
        throw new NotFoundError(`RDS instance not found: ${id}`)
      }

      return {
        data: result,
      }
    }
  )

  // Set instance to draining mode
  fastify.post(
    '/admin/v1/rds-instances/:id/drain',
    {
      preHandler: [authPreHandler, validateParams(instanceIdSchema)],
    },
    async (request, _reply) => {
      const { id } = request.params as z.infer<typeof instanceIdSchema>

      const instance = await getRdsInstanceById(id)
      if (!instance) {
        throw new NotFoundError(`RDS instance not found: ${id}`)
      }

      if (instance.is_management_instance) {
        throw new ConflictError('Cannot drain management instance')
      }

      const success = await setInstanceDraining(id)

      if (!success) {
        throw new BadRequestError('Failed to set instance to draining mode')
      }

      const updated = await getRdsInstanceById(id)

      return {
        data: {
          ...updated,
          admin_credential: undefined,
        },
      }
    }
  )
}
