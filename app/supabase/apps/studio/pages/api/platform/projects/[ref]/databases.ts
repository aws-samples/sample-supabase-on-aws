import { NextApiRequest, NextApiResponse } from 'next'

import { paths } from 'api-types'
import apiWrapper from 'lib/api/apiWrapper'
import { PROJECT_REST_URL } from 'lib/constants/api'
import { IS_PLATFORM } from 'lib/constants'

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

type ResponseData =
  paths['/platform/projects/{ref}/databases']['get']['responses']['200']['content']['application/json']

const handleGet = async (req: NextApiRequest, res: NextApiResponse<ResponseData>) => {
  const { ref } = req.query

  // Self-hosted multi-tenant mode
  if (!IS_PLATFORM && typeof ref === 'string') {
    const { getProject, getEncryptedConnectionStringForProject } = await import(
      'lib/api/tenant-manager/projects'
    )
    const project = await getProject(ref)
    if (project) {
      const connectionString = await getEncryptedConnectionStringForProject(project)
      return res.status(200).json([
        {
          cloud_provider: 'localhost' as any,
          connectionString: connectionString,
          connection_string_read_only: '',
          db_host: project.db_host,
          db_name: project.db_name,
          db_port: project.db_port,
          db_user: 'postgres',
          identifier: ref,
          inserted_at: project.inserted_at,
          region: project.region || 'local',
          restUrl: PROJECT_REST_URL,
          size: '',
          status: 'ACTIVE_HEALTHY',
        },
      ])
    }
  }

  // Default response (non-multi-tenant mode)
  return res.status(200).json([
    {
      cloud_provider: 'localhost' as any,
      connectionString: '',
      connection_string_read_only: '',
      db_host: '127.0.0.1',
      db_name: 'postgres',
      db_port: 5432,
      db_user: 'postgres',
      identifier: 'default',
      inserted_at: '',
      region: 'local',
      restUrl: PROJECT_REST_URL,
      size: '',
      status: 'ACTIVE_HEALTHY',
    },
  ])
}
