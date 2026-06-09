/**
 * Unit test for the /resume alias.
 *
 * PDF 二期 §3.a asks for `admin/v1/project/resume`. The fork already exposes
 * `/admin/v1/projects/:ref/restore`. We add `/resume` as an alias that goes
 * through the same `restoreProject` service, so existing callers and the new
 * verb both work without divergent semantics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { FastifyInstance } from 'fastify'

const restoreProject = vi.fn()
const pauseProject = vi.fn()
const provisionProject = vi.fn()
const deprovisionProject = vi.fn()
const getProjectByRef = vi.fn()
const listProjects = vi.fn().mockResolvedValue([])
const getProjectsCount = vi.fn().mockResolvedValue(0)
const updateProject = vi.fn()
const checkProjectHealth = vi.fn()
const getProjectDatabaseCredentials = vi.fn()

vi.mock('../../src/modules/project/project.service.js', () => ({
  provisionProject: (...args: unknown[]) => provisionProject(...args),
  deprovisionProject: (...args: unknown[]) => deprovisionProject(...args),
  getProjectByRef: (...args: unknown[]) => getProjectByRef(...args),
  listProjects: (...args: unknown[]) => listProjects(...args),
  getProjectsCount: (...args: unknown[]) => getProjectsCount(...args),
  pauseProject: (...args: unknown[]) => pauseProject(...args),
  restoreProject: (...args: unknown[]) => restoreProject(...args),
  updateProject: (...args: unknown[]) => updateProject(...args),
  checkProjectHealth: (...args: unknown[]) => checkProjectHealth(...args),
  getProjectDatabaseCredentials: (...args: unknown[]) => getProjectDatabaseCredentials(...args),
}))

vi.mock('../../src/db/platform-queries.js', () => ({
  getJwtSecretForProject: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../src/common/middleware/auth.middleware.js', () => ({
  // Bypass auth for these route-shape unit tests.
  createAuthPreHandler: () => async () => undefined,
}))

let app: FastifyInstance

beforeEach(async () => {
  restoreProject.mockReset()
  pauseProject.mockReset()
  app = Fastify()
  const { projectRoutes } = await import('../../src/modules/project/project.routes.js')
  await app.register(projectRoutes)
  await app.ready()
})

describe('POST /admin/v1/projects/:ref/resume (alias)', () => {
  it('exists and returns 200 with the same payload shape as /restore', async () => {
    restoreProject.mockResolvedValue({
      success: true,
      project: { ref: 'abc', status: 'ACTIVE_HEALTHY' },
    })

    const resp = await app.inject({
      method: 'POST',
      url: '/admin/v1/projects/abc/resume',
    })

    expect(resp.statusCode).toBe(200)
    expect(JSON.parse(resp.body)).toEqual({
      data: { ref: 'abc', status: 'ACTIVE_HEALTHY' },
    })
    expect(restoreProject).toHaveBeenCalledWith('abc')
  })

  it('returns the same response as /restore for the same ref', async () => {
    restoreProject.mockResolvedValue({
      success: true,
      project: { ref: 'abc', status: 'ACTIVE_HEALTHY' },
    })

    const restoreResp = await app.inject({
      method: 'POST',
      url: '/admin/v1/projects/abc/restore',
    })
    const resumeResp = await app.inject({
      method: 'POST',
      url: '/admin/v1/projects/abc/resume',
    })

    expect(restoreResp.statusCode).toBe(resumeResp.statusCode)
    expect(restoreResp.body).toBe(resumeResp.body)
  })

  it('propagates not-found errors as 404', async () => {
    restoreProject.mockResolvedValue({
      success: false,
      error: 'Project not found: missing',
    })

    const resp = await app.inject({
      method: 'POST',
      url: '/admin/v1/projects/missing/resume',
    })

    expect(resp.statusCode).toBe(404)
  })

  it('propagates not-paused errors as 400', async () => {
    restoreProject.mockResolvedValue({
      success: false,
      error: 'Project is not paused: abc',
    })

    const resp = await app.inject({
      method: 'POST',
      url: '/admin/v1/projects/abc/resume',
    })

    expect(resp.statusCode).toBe(400)
  })
})
