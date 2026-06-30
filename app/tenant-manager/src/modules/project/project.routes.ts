/**
 * Project management routes
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { createAuthPreHandler } from '../../common/middleware/auth.middleware.js'
import { validateBody, validateQuery, validateParams } from '../../common/validation/middleware.js'
import { projectRefSchema } from '../../common/validation/schemas.js'
import { createProjectSchema, updateProjectSchema, listProjectsSchema } from './project.schemas.js'
import { googleProviderSchema } from './oauth-provider.schemas.js'
import {
  provisionProject,
  deprovisionProject,
  getProjectByRef,
  listProjects,
  getProjectsCount,
  pauseProject,
  restoreProject,
  updateProject,
  checkProjectHealth,
  getProjectDatabaseCredentials,
} from './project.service.js'
import {
  setGoogleProvider,
  getGoogleProviderMasked,
  deleteGoogleProvider,
  buildExternalConfigForGoTrue,
} from './oauth-provider.service.js'
import type { GoogleProviderInput } from './oauth-provider.schemas.js'
import { getJwtSecretForProject } from '../../db/platform-queries.js'
import { NotFoundError, BadRequestError, TenantManagerError } from '../../common/errors/index.js'

export async function projectRoutes(fastify: FastifyInstance): Promise<void> {
  const authPreHandler = createAuthPreHandler()

  // List projects
  fastify.get(
    '/admin/v1/projects',
    {
      preHandler: [authPreHandler, validateQuery(listProjectsSchema)],
    },
    async (request, _reply) => {
      const query = request.query as z.infer<typeof listProjectsSchema>
      const [projects, total] = await Promise.all([
        listProjects(query),
        getProjectsCount(query),
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

  // Create project
  fastify.post(
    '/admin/v1/projects',
    {
      preHandler: [authPreHandler, validateBody(createProjectSchema)],
    },
    async (request, reply) => {
      const input = request.body as z.infer<typeof createProjectSchema>
      // ConflictError is thrown by assertRefAvailable before any side
      // effects; it propagates straight to the fastify error handler which
      // emits a 409 with the original code. Anything else returns inside
      // ProvisioningResult.error.
      const result = await provisionProject(input)

      if (!result.success) {
        throw new BadRequestError(result.error || 'Failed to create project')
      }

      return reply.status(201).send({
        data: {
          ...result.project,
          api_keys: result.api_keys,
        },
      })
    }
  )

  // Get project by ref
  fastify.get(
    '/admin/v1/projects/:ref',
    {
      preHandler: [authPreHandler, validateParams(projectRefSchema)],
    },
    async (request, _reply) => {
      const { ref } = request.params as z.infer<typeof projectRefSchema>

      // These three reads are independent, so fetch them concurrently:
      //   - project row
      //   - jwt_secret from supabase_platform.jwt_keys for GoTrue JWT signing
      //   - per-tenant external OAuth providers (decrypted) for GoTrue
      const [project, jwtSecret, external] = await Promise.all([
        getProjectByRef(ref),
        getJwtSecretForProject(ref),
        buildExternalConfigForGoTrue(ref),
      ])

      if (!project) {
        throw new NotFoundError(`Project not found: ${ref}`)
      }

      return {
        data: {
          ...project,
          jwt_secret: jwtSecret || undefined,
          external: external || undefined,
        },
      }
    }
  )

  // ---- Per-tenant external OAuth provider: Google ----

  // Set/replace the Google provider config for a project.
  fastify.put(
    '/admin/v1/projects/:ref/auth/external/google',
    {
      preHandler: [authPreHandler, validateParams(projectRefSchema), validateBody(googleProviderSchema)],
    },
    async (request, _reply) => {
      const { ref } = request.params as z.infer<typeof projectRefSchema>
      const input = request.body as GoogleProviderInput

      const project = await getProjectByRef(ref)
      if (!project) {
        throw new NotFoundError(`Project not found: ${ref}`)
      }

      await setGoogleProvider(ref, input)

      const config = await getGoogleProviderMasked(ref)
      return { data: config }
    }
  )

  // Get the Google provider config (secret masked).
  fastify.get(
    '/admin/v1/projects/:ref/auth/external/google',
    {
      preHandler: [authPreHandler, validateParams(projectRefSchema)],
    },
    async (request, _reply) => {
      const { ref } = request.params as z.infer<typeof projectRefSchema>

      const project = await getProjectByRef(ref)
      if (!project) {
        throw new NotFoundError(`Project not found: ${ref}`)
      }

      const config = await getGoogleProviderMasked(ref)
      if (!config) {
        throw new NotFoundError(`Google provider not configured for project: ${ref}`)
      }
      return { data: config }
    }
  )

  // Delete the Google provider config.
  fastify.delete(
    '/admin/v1/projects/:ref/auth/external/google',
    {
      preHandler: [authPreHandler, validateParams(projectRefSchema)],
    },
    async (request, reply) => {
      const { ref } = request.params as z.infer<typeof projectRefSchema>

      const project = await getProjectByRef(ref)
      if (!project) {
        throw new NotFoundError(`Project not found: ${ref}`)
      }

      await deleteGoogleProvider(ref)
      return reply.status(204).send()
    }
  )

  // Update project
  fastify.patch(
    '/admin/v1/projects/:ref',
    {
      preHandler: [authPreHandler, validateParams(projectRefSchema), validateBody(updateProjectSchema)],
    },
    async (request, _reply) => {
      const { ref } = request.params as z.infer<typeof projectRefSchema>
      const updates = request.body as z.infer<typeof updateProjectSchema>

      const result = await updateProject(ref, updates)

      if (!result.success) {
        if (result.error?.includes('not found')) {
          throw new NotFoundError(result.error)
        }
        throw new BadRequestError(result.error || 'Failed to update project')
      }

      return {
        data: result.project,
      }
    }
  )

  // Delete project
  fastify.delete(
    '/admin/v1/projects/:ref',
    {
      preHandler: [authPreHandler, validateParams(projectRefSchema)],
    },
    async (request, reply) => {
      const { ref } = request.params as z.infer<typeof projectRefSchema>
      const result = await deprovisionProject(ref)

      if (!result.success) {
        if (result.error?.includes('not found')) {
          throw new NotFoundError(result.error)
        }
        throw new BadRequestError(result.error || 'Failed to delete project')
      }

      return reply.status(204).send()
    }
  )

  // Pause project
  fastify.post(
    '/admin/v1/projects/:ref/pause',
    {
      preHandler: [authPreHandler, validateParams(projectRefSchema)],
    },
    async (request, _reply) => {
      const { ref } = request.params as z.infer<typeof projectRefSchema>
      const result = await pauseProject(ref)

      if (!result.success) {
        if (result.error?.includes('not found')) {
          throw new NotFoundError(result.error)
        }
        throw new BadRequestError(result.error || 'Failed to pause project')
      }

      return {
        data: result.project,
      }
    }
  )

  // Restore project (canonical) and /resume (PDF §3.a alias).
  // Both verbs share the same handler so existing callers and the documented
  // verb in the v2 spec resolve to identical semantics.
  const restoreHandler = async (request: FastifyRequest, _reply: FastifyReply) => {
    const { ref } = request.params as z.infer<typeof projectRefSchema>
    const result = await restoreProject(ref)

    if (!result.success) {
      if (result.error?.includes('not found')) {
        throw new NotFoundError(result.error)
      }
      throw new BadRequestError(result.error || 'Failed to restore project')
    }

    return {
      data: result.project,
    }
  }

  for (const path of ['/admin/v1/projects/:ref/restore', '/admin/v1/projects/:ref/resume']) {
    fastify.post(
      path,
      {
        preHandler: [authPreHandler, validateParams(projectRefSchema)],
      },
      restoreHandler,
    )
  }

  // Get database credentials for a project
  fastify.get(
    '/admin/v1/projects/:ref/database-credentials',
    {
      preHandler: [authPreHandler, validateParams(projectRefSchema)],
    },
    async (request, _reply) => {
      const { ref } = request.params as z.infer<typeof projectRefSchema>
      const result = await getProjectDatabaseCredentials(ref)

      if (!result.success) {
        switch (result.error) {
          case 'not_found':
            throw new NotFoundError(result.message)
          case 'no_instance':
            throw new BadRequestError(result.message)
          case 'instance_not_found':
          case 'credentials_failed':
            throw new TenantManagerError(result.message, 500)
        }
      }

      return { data: result.data }
    }
  )

  // Health check for a specific project
  fastify.get(
    '/admin/v1/projects/:ref/health',
    {
      preHandler: [authPreHandler, validateParams(projectRefSchema)],
    },
    async (request, reply) => {
      const { ref } = request.params as z.infer<typeof projectRefSchema>
      const health = await checkProjectHealth(ref)

      if (health.errors.includes('Project not found')) {
        throw new NotFoundError(`Project not found: ${ref}`)
      }

      const statusCode = health.healthy ? 200 : 503
      return reply.status(statusCode).send({ data: health })
    }
  )
}
