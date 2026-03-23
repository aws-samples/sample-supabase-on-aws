/**
 * JWT key management routes
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createAuthPreHandler } from '../../common/middleware/auth.middleware.js'
import { validateParams } from '../../common/validation/middleware.js'
import { jwtKeyProjectRefSchema } from './jwt-key.schemas.js'
import { listJwtKeys, createStandbyKey, rotateJwtKeys } from './jwt-key.service.js'

export async function jwtKeyRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandler = createAuthPreHandler()

  // List JWT signing keys (secrets not exposed)
  fastify.get(
    '/admin/v1/projects/:ref/jwt-keys',
    {
      preHandler: [authPreHandler, validateParams(jwtKeyProjectRefSchema)],
    },
    async (request, _reply) => {
      const { ref } = request.params as z.infer<typeof jwtKeyProjectRefSchema>
      const keys = await listJwtKeys(ref)
      return { data: keys }
    }
  )

  // Create a standby key for future rotation
  fastify.post(
    '/admin/v1/projects/:ref/jwt-keys/standby',
    {
      preHandler: [authPreHandler, validateParams(jwtKeyProjectRefSchema)],
    },
    async (request, reply) => {
      const { ref } = request.params as z.infer<typeof jwtKeyProjectRefSchema>
      const key = await createStandbyKey(ref)
      return reply.status(201).send({ data: key })
    }
  )

  // Rotate JWT keys (standby -> current -> previous)
  fastify.post(
    '/admin/v1/projects/:ref/jwt-keys/rotate',
    {
      preHandler: [authPreHandler, validateParams(jwtKeyProjectRefSchema)],
    },
    async (request, _reply) => {
      const { ref } = request.params as z.infer<typeof jwtKeyProjectRefSchema>
      const result = await rotateJwtKeys(ref)
      return { data: result }
    }
  )
}
