/**
 * Unit tests for the Edge Function admin routes.
 *
 * Covers:
 *   GET    /admin/v1/projects/:ref/functions
 *   GET    /admin/v1/projects/:ref/functions/:slug
 *   PATCH  /admin/v1/projects/:ref/functions/:slug
 *   DELETE /admin/v1/projects/:ref/functions/:slug
 *
 * Plus the unauthenticated internal lookup used by Kong:
 *   GET /internal/v1/projects/:ref/functions/:slug
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'

const findFunction = vi.fn()
const listFunctions = vi.fn()
const upsertFunction = vi.fn()
const deleteFunction = vi.fn()

vi.mock('../../src/db/repositories/function.repository.js', () => ({
  findFunction: (...args: unknown[]) => findFunction(...args),
  listFunctions: (...args: unknown[]) => listFunctions(...args),
  upsertFunction: (...args: unknown[]) => upsertFunction(...args),
  deleteFunction: (...args: unknown[]) => deleteFunction(...args),
}))

vi.mock('../../src/common/middleware/auth.middleware.js', () => ({
  createAuthPreHandler: () => async () => undefined,
}))

let app: FastifyInstance

beforeEach(async () => {
  findFunction.mockReset()
  listFunctions.mockReset()
  upsertFunction.mockReset()
  deleteFunction.mockReset()
  app = Fastify()
  const { functionRoutes } = await import('../../src/modules/functions/function.routes.js')
  await app.register(functionRoutes)
  await app.ready()
})

describe('GET /admin/v1/projects/:ref/functions', () => {
  it('lists functions for a project', async () => {
    listFunctions.mockResolvedValueOnce([
      { project_ref: 'abc', slug: 'a', verify_jwt: true },
      { project_ref: 'abc', slug: 'b', verify_jwt: false },
    ])

    const resp = await app.inject({
      method: 'GET',
      url: '/admin/v1/projects/abc/functions',
    })

    expect(resp.statusCode).toBe(200)
    expect(JSON.parse(resp.body).data).toHaveLength(2)
    expect(listFunctions).toHaveBeenCalledWith('abc')
  })
})

describe('GET /admin/v1/projects/:ref/functions/:slug', () => {
  it('returns a function by slug', async () => {
    findFunction.mockResolvedValueOnce({
      project_ref: 'abc', slug: 'webhook', verify_jwt: false,
    })

    const resp = await app.inject({
      method: 'GET',
      url: '/admin/v1/projects/abc/functions/webhook',
    })

    expect(resp.statusCode).toBe(200)
    expect(JSON.parse(resp.body).data.verify_jwt).toBe(false)
  })

  it('returns 404 when the function does not exist', async () => {
    findFunction.mockResolvedValueOnce(null)

    const resp = await app.inject({
      method: 'GET',
      url: '/admin/v1/projects/abc/functions/missing',
    })

    expect(resp.statusCode).toBe(404)
  })
})

describe('PATCH /admin/v1/projects/:ref/functions/:slug', () => {
  it('upserts function metadata', async () => {
    upsertFunction.mockResolvedValueOnce({
      project_ref: 'abc', slug: 'webhook', verify_jwt: false, name: 'Webhook',
    })

    const resp = await app.inject({
      method: 'PATCH',
      url: '/admin/v1/projects/abc/functions/webhook',
      payload: { verify_jwt: false, name: 'Webhook' },
    })

    expect(resp.statusCode).toBe(200)
    expect(upsertFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        project_ref: 'abc',
        slug: 'webhook',
        verify_jwt: false,
        name: 'Webhook',
      })
    )
  })

  it('rejects invalid verify_jwt type', async () => {
    const resp = await app.inject({
      method: 'PATCH',
      url: '/admin/v1/projects/abc/functions/webhook',
      payload: { verify_jwt: 'yes' },
    })
    expect(resp.statusCode).toBe(400)
  })
})

describe('DELETE /admin/v1/projects/:ref/functions/:slug', () => {
  it('returns 204 when the function is deleted', async () => {
    deleteFunction.mockResolvedValueOnce(true)

    const resp = await app.inject({
      method: 'DELETE',
      url: '/admin/v1/projects/abc/functions/webhook',
    })

    expect(resp.statusCode).toBe(204)
  })

  it('returns 404 when nothing was deleted', async () => {
    deleteFunction.mockResolvedValueOnce(false)

    const resp = await app.inject({
      method: 'DELETE',
      url: '/admin/v1/projects/abc/functions/missing',
    })

    expect(resp.statusCode).toBe(404)
  })
})

describe('GET /internal/v1/projects/:ref/functions/:slug (Kong lookup)', () => {
  it('returns a minimal payload usable by Kong pre-function', async () => {
    findFunction.mockResolvedValueOnce({
      project_ref: 'abc', slug: 'webhook', verify_jwt: false,
    })

    const resp = await app.inject({
      method: 'GET',
      url: '/internal/v1/projects/abc/functions/webhook',
    })

    expect(resp.statusCode).toBe(200)
    const body = JSON.parse(resp.body)
    expect(body).toEqual({
      project_ref: 'abc',
      slug: 'webhook',
      verify_jwt: false,
    })
  })

  it('returns the safe default verify_jwt=true when no metadata row exists', async () => {
    // Kong lookup must never 404 — that would block all unconfigured
    // functions. Default to verify_jwt=true (the secure default), so
    // unconfigured functions still require apikey.
    findFunction.mockResolvedValueOnce(null)

    const resp = await app.inject({
      method: 'GET',
      url: '/internal/v1/projects/abc/functions/unknown',
    })

    expect(resp.statusCode).toBe(200)
    const body = JSON.parse(resp.body)
    expect(body.verify_jwt).toBe(true)
  })
})
