/**
 * Request validation middleware using Zod
 */

import type { FastifyRequest, FastifyReply } from 'fastify'
import { z, ZodError, ZodSchema } from 'zod'
import { BadRequestError } from '../errors/index.js'

/**
 * Create a validation preHandler for request body
 */
export function validateBody<T extends ZodSchema>(schema: T) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      const parsed = schema.parse(request.body)
      // Replace request body with parsed/validated data
      ;(request as { body: z.infer<T> }).body = parsed
    } catch (error) {
      if (error instanceof ZodError) {
        const messages = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
        throw new BadRequestError(`Validation failed: ${messages}`)
      }
      throw error
    }
  }
}

/**
 * Create a validation preHandler for query parameters
 */
export function validateQuery<T extends ZodSchema>(schema: T) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      const parsed = schema.parse(request.query)
      ;(request as { query: z.infer<T> }).query = parsed
    } catch (error) {
      if (error instanceof ZodError) {
        const messages = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
        throw new BadRequestError(`Invalid query parameters: ${messages}`)
      }
      throw error
    }
  }
}

/**
 * Create a validation preHandler for route parameters
 */
export function validateParams<T extends ZodSchema>(schema: T) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      const parsed = schema.parse(request.params)
      ;(request as { params: z.infer<T> }).params = parsed
    } catch (error) {
      if (error instanceof ZodError) {
        const messages = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
        throw new BadRequestError(`Invalid route parameters: ${messages}`)
      }
      throw error
    }
  }
}
