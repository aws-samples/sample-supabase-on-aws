import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from 'lib/api/apiWrapper'
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
  const { ref, id } = req.query

  if (IS_PLATFORM) {
    return res.status(405).json({
      data: null,
      error: { message: 'Not supported in platform mode' },
    })
  }

  try {
    const { getAPIKey } = await import('lib/api/tenant-manager/api-keys')
    const key = await getAPIKey(ref as string, id as string)

    if (!key) {
      return res.status(404).json({
        data: null,
        error: { message: `API key not found: ${id}` },
      })
    }

    return res.status(200).json(key)
  } catch (error) {
    console.error('Failed to get API key:', error)
    return res.status(500).json({
      data: null,
      error: { message: error instanceof Error ? error.message : 'Internal server error' },
    })
  }
}

const handleDelete = async (req: NextApiRequest, res: NextApiResponse) => {
  const { ref, id } = req.query

  if (IS_PLATFORM) {
    return res.status(405).json({
      data: null,
      error: { message: 'Not supported in platform mode' },
    })
  }

  try {
    const { deleteAPIKey } = await import('lib/api/tenant-manager/api-keys')
    const result = await deleteAPIKey(ref as string, id as string)

    if (!result.success) {
      return res.status(500).json({
        data: null,
        error: { message: result.error || 'Failed to delete API key' },
      })
    }

    return res.status(200).json({ message: 'API key deleted successfully' })
  } catch (error) {
    console.error('Failed to delete API key:', error)
    return res.status(500).json({
      data: null,
      error: { message: error instanceof Error ? error.message : 'Internal server error' },
    })
  }
}
