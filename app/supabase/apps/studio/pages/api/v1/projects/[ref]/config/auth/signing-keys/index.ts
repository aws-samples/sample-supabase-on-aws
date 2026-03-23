import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from 'lib/api/apiWrapper'
import { IS_PLATFORM } from 'lib/constants'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    case 'POST':
      return handlePost(req, res)
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  const { ref } = req.query

  if (!IS_PLATFORM) {
    try {
      const { listJWTKeys } = await import('lib/api/tenant-manager/jwt-keys')
      const result = await listJWTKeys(ref as string)
      return res.status(200).json(result)
    } catch (error) {
      console.error('Failed to list JWT signing keys:', error)
    }
  }

  // Fallback: return empty keys list
  return res.status(200).json({ keys: [] })
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  const { ref } = req.query

  if (IS_PLATFORM) {
    return res.status(405).json({
      data: null,
      error: { message: 'Not supported in platform mode' },
    })
  }

  try {
    const { createStandbyKey } = await import('lib/api/tenant-manager/jwt-keys')
    const key = await createStandbyKey(ref as string, req.body)

    if (!key) {
      return res.status(500).json({
        data: null,
        error: { message: 'Failed to create signing key' },
      })
    }

    return res.status(201).json(key)
  } catch (error) {
    console.error('Failed to create signing key:', error)
    return res.status(500).json({
      data: null,
      error: { message: error instanceof Error ? error.message : 'Internal server error' },
    })
  }
}
