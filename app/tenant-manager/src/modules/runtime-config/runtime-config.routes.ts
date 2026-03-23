/**
 * Runtime config routes for Kong plugin and PostgREST Lambda.
 * These replace project-service's /project/:id/config and /project/:id/postgrest-config.
 * No auth required — internal VPC-only access.
 */

import type { FastifyInstance } from 'fastify'
import { getProjectConfig, getPostgrestConfig } from '../../db/platform-queries.js'

export async function runtimeConfigRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /project/:ref/config — for Kong dynamic-lambda-router plugin
  fastify.get('/project/:ref/config', async (request, reply) => {
    const { ref } = request.params as { ref: string }

    const config = await getProjectConfig(ref)
    if (!config) {
      return reply.status(404).send({ error: `Project not found: ${ref}` })
    }

    return config
  })

  // GET /project/:ref/postgrest-config — for PostgREST Lambda bootstrap
  fastify.get('/project/:ref/postgrest-config', async (request, reply) => {
    const { ref } = request.params as { ref: string }

    const config = await getPostgrestConfig(ref)
    if (!config) {
      return reply.status(404).send({ error: `PostgREST config not found for project: ${ref}` })
    }

    return config
  })
}
