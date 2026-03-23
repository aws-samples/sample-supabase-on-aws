import { NextApiRequest, NextApiResponse } from 'next'

import { paths } from 'api-types'
import apiWrapper from 'lib/api/apiWrapper'
import { IS_PLATFORM } from 'lib/constants'
import { DEFAULT_PROJECT } from 'lib/constants/api'

type ResponseData =
  paths['/v1/organizations/{slug}/projects']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse<ResponseData>) {
  const {
    limit = '96',
    offset = '0',
    sort = 'name_asc',
    search,
    statuses,
  } = req.query as {
    limit?: string
    offset?: string
    sort?: string
    search?: string
    statuses?: string
  }

  const limitNum = parseInt(limit, 10)
  const offsetNum = parseInt(offset, 10)

  // Self-hosted multi-tenant mode
  if (!IS_PLATFORM) {
    try {
      const { listProjectsByOrganization } = await import('lib/api/tenant-manager/projects')

      const result = await listProjectsByOrganization({
        limit: limitNum,
        offset: offsetNum,
        sort: sort as 'name_asc' | 'name_desc' | 'created_asc' | 'created_desc',
        search,
        statuses: statuses ? statuses.split(',') : undefined,
      })

      // Cast to ResponseData for API compatibility (self-hosted mode returns simplified data)
      return res.status(200).json(result as unknown as ResponseData)
    } catch (error) {
      console.error('Failed to list projects by organization:', error)
      // Fallback to default project
      return res.status(200).json({
        pagination: {
          count: 1,
          limit: limitNum,
          offset: offsetNum,
        },
        projects: [
          {
            cloud_provider: DEFAULT_PROJECT.cloud_provider,
            databases: [],
            inserted_at: DEFAULT_PROJECT.inserted_at,
            is_branch: false,
            name: DEFAULT_PROJECT.name,
            ref: DEFAULT_PROJECT.ref,
            region: DEFAULT_PROJECT.region,
            status: DEFAULT_PROJECT.status as ResponseData['projects'][0]['status'],
          },
        ],
      })
    }
  }

  // Platform mode - return default project
  const response: ResponseData = {
    pagination: {
      count: 1,
      limit: limitNum,
      offset: offsetNum,
    },
    projects: [
      {
        cloud_provider: DEFAULT_PROJECT.cloud_provider,
        databases: [],
        inserted_at: DEFAULT_PROJECT.inserted_at,
        is_branch: false,
        name: DEFAULT_PROJECT.name,
        ref: DEFAULT_PROJECT.ref,
        region: DEFAULT_PROJECT.region,
        status: DEFAULT_PROJECT.status as ResponseData['projects'][0]['status'],
      },
    ],
  }

  return res.status(200).json(response)
}
