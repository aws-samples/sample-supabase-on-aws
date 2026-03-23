/**
 * API key management routes
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createAuthPreHandler } from '../../common/middleware/auth.middleware.js'
import { validateBody, validateParams } from '../../common/validation/middleware.js'
import { createApiKeySchema, apiKeyParamsSchema, projectRefOnlySchema } from './api-key.schemas.js'
import { createApiKey, listApiKeys, getApiKey, revokeApiKey } from './api-key.service.js'
import { NotFoundError } from '../../common/errors/index.js'

export async function apiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandler = createAuthPreHandler()

  // List API keys for a project
  fastify.get(
    '/admin/v1/projects/:ref/api-keys',
    {
      preHandler: [authPreHandler, validateParams(projectRefOnlySchema)],
    },
    async (request, _reply) => {
      const { ref } = request.params as z.infer<typeof projectRefOnlySchema>
      const keys = await listApiKeys(ref)
      return { data: keys }
    }
  )

  // Create a new API key
  fastify.post(
    '/admin/v1/projects/:ref/api-keys',
    {
      preHandler: [authPreHandler, validateParams(projectRefOnlySchema), validateBody(createApiKeySchema)],
    },
    async (request, reply) => {
      const { ref } = request.params as z.infer<typeof projectRefOnlySchema>
      const input = request.body as z.infer<typeof createApiKeySchema>
      const result = await createApiKey(ref, input)
      return reply.status(201).send({ data: result })
    }
  )

  // Get a single API key
  fastify.get(
    '/admin/v1/projects/:ref/api-keys/:keyId',
    {
      preHandler: [authPreHandler, validateParams(apiKeyParamsSchema)],
    },
    async (request, _reply) => {
      const { ref, keyId } = request.params as z.infer<typeof apiKeyParamsSchema>
      const key = await getApiKey(ref, keyId)
      if (!key) {
        throw new NotFoundError(`API key not found: ${keyId}`)
      }
      return { data: key }
    }
  )

  // Revoke an API key
  fastify.delete(
    '/admin/v1/projects/:ref/api-keys/:keyId',
    {
      preHandler: [authPreHandler, validateParams(apiKeyParamsSchema)],
    },
    async (request, reply) => {
      const { ref, keyId } = request.params as z.infer<typeof apiKeyParamsSchema>
      await revokeApiKey(ref, keyId)
      return reply.status(204).send()
    }
  )
}
