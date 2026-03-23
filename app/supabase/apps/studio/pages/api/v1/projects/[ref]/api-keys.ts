import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from 'lib/api/apiWrapper'
import { IS_PLATFORM } from 'lib/constants'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    case 'POST':
      return handlePost(req, res)
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const { ref } = req.query

  // Self-hosted multi-tenant mode: proxy to Tenant-Manager
  if (!IS_PLATFORM) {
    try {
      const { listAPIKeys } = await import('lib/api/tenant-manager/api-keys')
      const keys = await listAPIKeys(ref as string)

      // TM responded successfully — return its result even if empty
      return res.status(200).json(keys)
    } catch (error) {
      console.error('Failed to fetch API keys from Tenant-Manager:', error)
      // TM unavailable — fall through to env-based legacy keys
    }
  }

  // Fallback: return legacy keys from env (platform mode, or TM unavailable)
  const response = [
    {
      name: 'anon',
      api_key: process.env.SUPABASE_ANON_KEY ?? '',
      id: 'anon',
      type: 'legacy',
      hash: '',
      prefix: '',
      description: 'Legacy anon API key',
    },
    {
      name: 'service_role',
      api_key: process.env.SUPABASE_SERVICE_KEY ?? '',
      id: 'service_role',
      type: 'legacy',
      hash: '',
      prefix: '',
      description: 'Legacy service_role API key',
    },
  ]

  return res.status(200).json(response)
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  const { ref } = req.query

  if (IS_PLATFORM) {
    return res.status(405).json({
      data: null,
      error: { message: 'API key creation via this route is not supported in platform mode' },
    })
  }

  try {
    const { createAPIKey } = await import('lib/api/tenant-manager/api-keys')
    const result = await createAPIKey(ref as string, req.body)

    if (!result) {
      return res.status(500).json({
        data: null,
        error: { message: 'Failed to create API key' },
      })
    }

    return res.status(201).json(result.key)
  } catch (error) {
    console.error('Failed to create API key:', error)
    return res.status(500).json({
      data: null,
      error: { message: error instanceof Error ? error.message : 'Internal server error' },
    })
  }
}
