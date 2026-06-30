// Run this suite in multitenant mode so getConfig() loads without requiring a
// single-tenant JWT secret (jwtSecret is optional when MULTI_TENANT=true). This
// must be hoisted above all imports because config.ts captures env at load time.
vi.hoisted(() => {
  process.env.MULTI_TENANT = 'true'
  process.env.IS_MULTITENANT = 'true'
})

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { getConfig, mergeConfig } from '../../config'
import { adminTenantId, tenantId } from './tenant-id'

const { tenantId: defaultTenantId } = getConfig()

function failOnRequestChildLogger(app: FastifyInstance) {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.log.child = (() => {
      throw new Error('request.log.child should not be called by the tenant id plugin')
    }) as typeof request.log.child
  })
}

describe('tenant id plugins', () => {
  it('does not create an extra request child logger for API requests', async () => {
    const app = Fastify()

    failOnRequestChildLogger(app)
    await app.register(tenantId)
    app.get('/status', async () => ({ ok: true }))

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/status',
      })

      expect(response.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('does not create an extra request child logger for admin requests', async () => {
    const app = Fastify()

    failOnRequestChildLogger(app)
    await app.register(adminTenantId)
    app.get('/tenants/:tenantId', async (request) => ({ tenantId: request.tenantId }))

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-a',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ tenantId: 'tenant-a' })
    } finally {
      await app.close()
    }
  })

  it('sets the default tenant id for admin requests without tenant params', async () => {
    const app = Fastify()

    failOnRequestChildLogger(app)
    await app.register(adminTenantId)
    app.get('/status', async (request) => ({ tenantId: request.tenantId }))

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/status',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ tenantId: defaultTenantId })
    } finally {
      await app.close()
    }
  })
})

// supabase-on-aws fork: the tenant-id plugin reads Kong's `X-Project-ID` header
// first (set by Kong's pre-function from the project subdomain), falling back to
// the upstream `X-Forwarded-Host` regexp behavior. These tests load the plugin
// with isMultitenant=true (the production mode) via mergeConfig + dynamic import,
// since tenant-id.ts captures config at module load time.
describe('tenant id plugin - X-Project-ID fork customization', () => {
  async function loadMultitenantTenantIdPlugin(requestXForwardedHostRegExp?: string) {
    vi.resetModules()
    const configModule = await import('../../config')
    configModule.getConfig({ reload: true })
    configModule.mergeConfig({
      isMultitenant: true,
      requestXForwardedHostRegExp,
    })
    const { tenantId: tenantIdPlugin } = await import('./tenant-id')
    return tenantIdPlugin
  }

  it('uses X-Project-ID header as tenant id when present', async () => {
    const tenantIdPlugin = await loadMultitenantTenantIdPlugin()
    const app = Fastify()
    failOnRequestChildLogger(app)
    await app.register(tenantIdPlugin)
    app.get('/object', async (request) => ({ tenantId: request.tenantId }))

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/object',
        headers: { 'x-project-id': 'proj_abc123' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ tenantId: 'proj_abc123' })
    } finally {
      await app.close()
    }
  })

  it('falls back to X-Forwarded-Host regexp when X-Project-ID is absent', async () => {
    const tenantIdPlugin = await loadMultitenantTenantIdPlugin(
      '^([a-z]{20})\\.supabase\\.(?:co|in|net)$'
    )
    const app = Fastify()
    failOnRequestChildLogger(app)
    await app.register(tenantIdPlugin)
    app.get('/object', async (request) => ({ tenantId: request.tenantId }))

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/object',
        headers: { 'x-forwarded-host': 'abcdefghijklmnopqrst.supabase.co' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ tenantId: 'abcdefghijklmnopqrst' })
    } finally {
      await app.close()
    }
  })

  it('prefers X-Project-ID over X-Forwarded-Host when both are present', async () => {
    const tenantIdPlugin = await loadMultitenantTenantIdPlugin(
      '^([a-z]{20})\\.supabase\\.(?:co|in|net)$'
    )
    const app = Fastify()
    failOnRequestChildLogger(app)
    await app.register(tenantIdPlugin)
    app.get('/object', async (request) => ({ tenantId: request.tenantId }))

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/object',
        headers: {
          'x-project-id': 'proj_priority',
          'x-forwarded-host': 'abcdefghijklmnopqrst.supabase.co',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ tenantId: 'proj_priority' })
    } finally {
      await app.close()
    }
  })
})
