/**
 * Schema reload routes — trigger PostgREST Lambda schema cache refresh.
 * No auth required — internal VPC-only access (same pattern as runtime-config).
 */

import type { FastifyInstance } from 'fastify'
import { reloadPostgrestSchema } from './schema-reload.service.js'

export async function schemaReloadRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /internal/v1/projects/:ref/reload-schema
  fastify.post('/internal/v1/projects/:ref/reload-schema', async (request, reply) => {
    const { ref } = request.params as { ref: string }

    if (!ref || ref.length < 4 || !/^[a-z0-9]+$/.test(ref)) {
      return reply.status(400).send({ error: 'Invalid project ref' })
    }

    // Fire-and-forget: respond immediately, reload in background
    reloadPostgrestSchema(ref).catch((err) => {
      fastify.log.error(
        `[schema-reload] Background reload failed for ${ref}: ${err instanceof Error ? err.message : err}`,
      )
    })

    return reply.status(202).send({ message: 'Schema reload triggered', ref })
  })
}
