import { NextApiRequest, NextApiResponse } from 'next'

import { components } from 'api-types'
import apiWrapper from 'lib/api/apiWrapper'
import { IS_PLATFORM } from 'lib/constants'
import { PROJECT_ENDPOINT, PROJECT_ENDPOINT_PROTOCOL } from 'lib/constants/api'
import { getProjectSettings } from 'lib/api/self-hosted/settings'

type ProjectAppConfig = components['schemas']['ProjectSettingsResponse']['app_config'] & {
  protocol?: string
}
export type ProjectSettings = components['schemas']['ProjectSettingsResponse'] & {
  app_config?: ProjectAppConfig
}

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const { ref } = req.query

  // Self-hosted multi-tenant mode: fetch tenant-specific settings
  if (!IS_PLATFORM) {
    try {
      const { getProject } = await import('lib/api/tenant-manager/projects')
      const project = await getProject(ref as string)

      if (!project) {
        // For the default project, fall through to getProjectSettings()
        if (ref !== 'default') {
          return res.status(404).json({
            data: null,
            error: { message: `Project not found: ${ref}` },
          })
        }
      } else {
        let apiKeys: import('lib/api/tenant-manager/api-keys').StudioAPIKey[] = []
        try {
          const { listAPIKeys } = await import('lib/api/tenant-manager/api-keys')
          apiKeys = await listAPIKeys(ref as string)
        } catch {
          // API keys fetch failed — continue with empty keys
        }

        const serviceKey = apiKeys.find((k) => k.name === 'service_role')
        const anonKey = apiKeys.find((k) => k.name === 'anon')

        const response = {
          app_config: {
            db_schema: 'public',
            endpoint: PROJECT_ENDPOINT,
            storage_endpoint: PROJECT_ENDPOINT,
            protocol: PROJECT_ENDPOINT_PROTOCOL,
          },
          cloud_provider: project.cloud_provider || 'AWS',
          db_dns_name: '-',
          db_host: project.db_host || 'localhost',
          db_ip_addr_config: 'legacy' as const,
          db_name: project.db_name || 'postgres',
          db_port: project.db_port || 5432,
          db_user: 'postgres',
          inserted_at: project.inserted_at,
          jwt_secret: project.jwt_secret ?? process.env.AUTH_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long',
          name: project.name,
          ref: project.ref,
          region: project.region,
          service_api_keys: [
            {
              api_key: serviceKey?.api_key ?? process.env.SUPABASE_SERVICE_KEY ?? '',
              name: 'service_role key',
              tags: 'service_role',
            },
            {
              api_key: anonKey?.api_key ?? process.env.SUPABASE_ANON_KEY ?? '',
              name: 'anon key',
              tags: 'anon',
            },
          ],
          ssl_enforced: false,
          status: project.status || 'ACTIVE_HEALTHY',
        } satisfies ProjectSettings

        return res.status(200).json(response)
      }
    } catch (error) {
      console.error('Failed to get tenant-specific settings:', error)
    }
  }

  // Fallback: return default self-hosted settings
  const response = getProjectSettings()
  return res.status(200).json(response)
}
