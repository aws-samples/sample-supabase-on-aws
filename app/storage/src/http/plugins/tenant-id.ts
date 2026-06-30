import fastifyPlugin from 'fastify-plugin'
import { getConfig } from '../../config'

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string
  }
}

const { isMultitenant, tenantId: defaultTenantId, requestXForwardedHostRegExp } = getConfig()

export const tenantId = fastifyPlugin(
  async (fastify) => {
    fastify.decorateRequest('tenantId', defaultTenantId)
    fastify.addHook('onRequest', (request, _reply, done) => {
      if (!isMultitenant) {
        done()
        return
      }

      // supabase-on-aws fork: Kong's pre-function plugin already extracts the
      // project subdomain into `X-Project-ID`. Honour that header first so the
      // existing edge-routing convention works end-to-end. Fall back to the
      // upstream `X-Forwarded-Host`-with-regex behavior for compatibility with
      // upstream tests and dev tooling. Every path must call done() — this is a
      // callback-style onRequest hook, not async.
      const xProjectId = request.headers['x-project-id']
      if (typeof xProjectId === 'string' && xProjectId.length > 0) {
        request.tenantId = xProjectId
        done()
        return
      }

      if (!requestXForwardedHostRegExp) {
        done()
        return
      }

      const xForwardedHost = request.headers['x-forwarded-host']
      if (typeof xForwardedHost !== 'string') {
        done()
        return
      }

      const result = xForwardedHost.match(requestXForwardedHostRegExp)
      if (!result) {
        done()
        return
      }

      request.tenantId = result[1]
      done()
    })
  },
  { name: 'tenant-id' }
)

export const adminTenantId = fastifyPlugin(
  async (fastify) => {
    fastify.decorateRequest('tenantId', defaultTenantId)
    fastify.addHook('onRequest', (request, _reply, done) => {
      const tenantId = (request.params as Record<string, undefined | string>).tenantId
      if (!tenantId) {
        done()
        return
      }

      request.tenantId = tenantId
      done()
    })
  },
  { name: 'admin-tenant-id' }
)
