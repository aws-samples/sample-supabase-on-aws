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
  if (IS_PLATFORM) {
    return res.status(404).json({
      data: null,
      error: { message: 'Not found' },
    })
  }

  // In self-hosted mode, the legacy JWT key is derived from AUTH_JWT_SECRET
  return res.status(200).json({
    id: 'legacy',
    algorithm: 'HS256',
    status: 'in_use',
    created_at: '2021-08-02T06:40:40.646Z',
    updated_at: '2021-08-02T06:40:40.646Z',
    public_jwk: null,
  })
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  if (IS_PLATFORM) {
    return res.status(405).json({
      data: null,
      error: { message: 'Not supported in platform mode' },
    })
  }

  // In self-hosted mode, legacy migration creates a new signing key from the JWT secret
  // For now, return the legacy key as already migrated
  return res.status(200).json({
    id: 'legacy',
    algorithm: 'HS256',
    status: 'in_use',
    created_at: '2021-08-02T06:40:40.646Z',
    updated_at: new Date().toISOString(),
    public_jwk: null,
  })
}
