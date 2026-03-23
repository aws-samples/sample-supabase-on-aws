import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from 'lib/api/apiWrapper'
import { DEFAULT_PROJECT } from 'lib/constants/api'
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
  // Self-hosted multi-tenant mode
  if (!IS_PLATFORM) {
    try {
      const { listProjects } = await import('lib/api/tenant-manager/projects')
      const projects = await listProjects()

      // If no projects exist, return the default project for backward compatibility
      if (projects.length === 0) {
        return res.status(200).json([DEFAULT_PROJECT])
      }

      // Map to API response format
      const response = projects.map((project) => ({
        id: project.id,
        ref: project.ref,
        name: project.name,
        organization_id: project.organization_id,
        cloud_provider: project.cloud_provider,
        status: project.status,
        region: project.region,
        inserted_at: project.inserted_at,
      }))

      return res.status(200).json(response)
    } catch (error) {
      console.error('Failed to list projects:', error)
      // Fallback to default project
      return res.status(200).json([DEFAULT_PROJECT])
    }
  }

  // Platform specific endpoint
  const response = [DEFAULT_PROJECT]
  return res.status(200).json(response)
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  // Only allow project creation in self-hosted mode
  if (IS_PLATFORM) {
    return res.status(403).json({
      data: null,
      error: { message: 'Project creation is not supported in platform mode' },
    })
  }

  try {
    const { name, ref, db_instance_id, region } = req.body

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        data: null,
        error: { message: 'Project name is required' },
      })
    }

    const { provisionProject } = await import('lib/api/tenant-manager/projects')

    const result = await provisionProject({
      name,
      ref,
      db_instance_id,
      region,
    })

    if (!result.success || !result.project) {
      return res.status(500).json({
        data: null,
        error: {
          message: result.error || 'Failed to create project',
          rollback_performed: result.rollbackPerformed,
        },
      })
    }

    // Return the created project
    return res.status(201).json({
      id: result.project.id,
      ref: result.project.ref,
      name: result.project.name,
      organization_id: result.project.organization_id,
      cloud_provider: result.project.cloud_provider,
      status: result.project.status,
      region: result.project.region,
      inserted_at: result.project.inserted_at,
      // Include keys in response for initial setup
      anon_key: result.project.anon_key,
      service_role_key: result.project.service_role_key,
    })
  } catch (error) {
    console.error('Failed to create project:', error)
    return res.status(500).json({
      data: null,
      error: { message: error instanceof Error ? error.message : 'Internal server error' },
    })
  }
}
