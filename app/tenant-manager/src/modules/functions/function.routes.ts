/**
 * Edge Function admin and internal routes.
 *
 *   /admin/v1/projects/:ref/functions             — list (auth)
 *   /admin/v1/projects/:ref/functions/:slug       — get / patch / delete (auth)
 *   /internal/v1/projects/:ref/functions/:slug    — Kong pre-function lookup (NO auth, VPC-only)
 *
 * Kong reads the internal endpoint on the request path to decide whether to
 * enforce key-auth. The internal endpoint must NEVER 404 — defaulting to
 * { verify_jwt: true } when no metadata exists keeps the secure default in
 * place even for functions that have not been configured via Studio yet.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createAuthPreHandler } from '../../common/middleware/auth.middleware.js'
import { validateBody, validateParams } from '../../common/validation/middleware.js'
import { projectRefSchema } from '../../common/validation/schemas.js'
import { NotFoundError } from '../../common/errors/index.js'
import {
  findFunction,
  listFunctions,
  upsertFunction,
  deleteFunction,
} from '../../db/repositories/function.repository.js'

const slugParamsSchema = projectRefSchema.extend({
  slug: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
})

const patchBodySchema = z.object({
  verify_jwt: z.boolean().optional(),
  import_map: z.boolean().optional(),
  name: z.string().min(1).max(255).optional(),
  lambda_arn: z.string().min(1).optional(),
})

export async function functionRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandler = createAuthPreHandler()

  // List
  fastify.get(
    '/admin/v1/projects/:ref/functions',
    {
      preHandler: [authPreHandler, validateParams(projectRefSchema)],
    },
    async (request) => {
      const { ref } = request.params as z.infer<typeof projectRefSchema>
      const data = await listFunctions(ref)
      return { data }
    }
  )

  // Get one
  fastify.get(
    '/admin/v1/projects/:ref/functions/:slug',
    {
      preHandler: [authPreHandler, validateParams(slugParamsSchema)],
    },
    async (request) => {
      const { ref, slug } = request.params as z.infer<typeof slugParamsSchema>
      const row = await findFunction(ref, slug)
      if (!row) {
        throw new NotFoundError(`Function not found: ${ref}/${slug}`)
      }
      return { data: row }
    }
  )

  // Patch (upsert) — Studio Switch lands here.
  fastify.patch(
    '/admin/v1/projects/:ref/functions/:slug',
    {
      preHandler: [
        authPreHandler,
        validateParams(slugParamsSchema),
        validateBody(patchBodySchema),
      ],
    },
    async (request) => {
      const { ref, slug } = request.params as z.infer<typeof slugParamsSchema>
      const body = request.body as z.infer<typeof patchBodySchema>
      const row = await upsertFunction({
        project_ref: ref,
        slug,
        verify_jwt: body.verify_jwt ?? true,
        import_map: body.import_map ?? false,
        name: body.name ?? null,
        lambda_arn: body.lambda_arn ?? null,
      })
      return { data: row }
    }
  )

  // Delete
  fastify.delete(
    '/admin/v1/projects/:ref/functions/:slug',
    {
      preHandler: [authPreHandler, validateParams(slugParamsSchema)],
    },
    async (request, reply) => {
      const { ref, slug } = request.params as z.infer<typeof slugParamsSchema>
      const ok = await deleteFunction(ref, slug)
      if (!ok) {
        throw new NotFoundError(`Function not found: ${ref}/${slug}`)
      }
      return reply.status(204).send()
    }
  )

  // Internal lookup for Kong pre-function. NO auth — must be VPC-isolated by
  // network policy (only Kong can reach tenant-manager:3001 internal port).
  // Defaults verify_jwt=true on miss so unconfigured functions stay secure.
  fastify.get(
    '/internal/v1/projects/:ref/functions/:slug',
    {
      preHandler: [validateParams(slugParamsSchema)],
    },
    async (request) => {
      const { ref, slug } = request.params as z.infer<typeof slugParamsSchema>
      const row = await findFunction(ref, slug)
      if (!row) {
        // Secure default. Kong will treat the function as JWT-required.
        return { project_ref: ref, slug, verify_jwt: true }
      }
      return {
        project_ref: row.project_ref,
        slug: row.slug,
        verify_jwt: row.verify_jwt,
      }
    }
  )
}
