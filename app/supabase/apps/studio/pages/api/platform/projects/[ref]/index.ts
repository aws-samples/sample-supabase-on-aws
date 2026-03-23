import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from 'lib/api/apiWrapper'
import { DEFAULT_PROJECT, PROJECT_REST_URL } from 'lib/constants/api'
import { IS_PLATFORM } from 'lib/constants'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    case 'DELETE':
      return handleDelete(req, res)
    default:
      res.setHeader('Allow', ['GET', 'DELETE'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  const { ref } = req.query

  // Self-hosted multi-tenant mode
  if (!IS_PLATFORM) {
    try {
      const { getProject, getEncryptedConnectionStringForProject } = await import(
        'lib/api/tenant-manager/projects'
      )
      const project = await getProject(ref as string)

      if (!project) {
        // Fallback to default project for backward compatibility
        if (ref === 'default') {
          return res.status(200).json({
            ...DEFAULT_PROJECT,
            connectionString: '',
            restUrl: PROJECT_REST_URL,
          })
        }
        return res.status(404).json({
          data: null,
          error: { message: `Project not found: ${ref}` },
        })
      }

      return res.status(200).json({
        id: project.id,
        ref: project.ref,
        name: project.name,
        organization_id: project.organization_id,
        cloud_provider: project.cloud_provider,
        status: project.status,
        region: project.region,
        inserted_at: project.inserted_at,
        connectionString: await getEncryptedConnectionStringForProject(project),
        restUrl: PROJECT_REST_URL,
      })
    } catch (error) {
      console.error('Failed to get project:', error)
      // Fallback to default project
      return res.status(200).json({
        ...DEFAULT_PROJECT,
        connectionString: '',
        restUrl: PROJECT_REST_URL,
      })
    }
  }

  // Platform specific endpoint
  const response = {
    ...DEFAULT_PROJECT,
    connectionString: '',
    restUrl: PROJECT_REST_URL,
  }

  return res.status(200).json(response)
}

const handleDelete = async (req: NextApiRequest, res: NextApiResponse) => {
  const { ref } = req.query

  // Only allow project deletion in self-hosted mode
  if (IS_PLATFORM) {
    return res.status(403).json({
      data: null,
      error: { message: 'Project deletion is not supported in platform mode' },
    })
  }

  // Don't allow deleting the default project
  if (ref === 'default') {
    return res.status(400).json({
      data: null,
      error: { message: 'Cannot delete the default project' },
    })
  }

  try {
    const { deprovisionProject } = await import('lib/api/tenant-manager/projects')

    const result = await deprovisionProject(ref as string)

    if (!result.success) {
      return res.status(500).json({
        data: null,
        error: { message: result.error || 'Failed to delete project' },
      })
    }

    return res.status(200).json({
      message: `Project ${ref} deleted successfully`,
    })
  } catch (error) {
    console.error('Failed to delete project:', error)
    return res.status(500).json({
      data: null,
      error: { message: error instanceof Error ? error.message : 'Internal server error' },
    })
  }
}
