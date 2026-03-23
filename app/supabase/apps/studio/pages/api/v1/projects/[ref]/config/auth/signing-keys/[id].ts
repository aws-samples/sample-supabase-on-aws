import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from 'lib/api/apiWrapper'
import { IS_PLATFORM } from 'lib/constants'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'PATCH':
      return handlePatch(req, res)
    case 'DELETE':
      return handleDelete(req, res)
    default:
      res.setHeader('Allow', ['PATCH', 'DELETE'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handlePatch = async (req: NextApiRequest, res: NextApiResponse) => {
  const { ref, id } = req.query
  const { status } = req.body

  if (IS_PLATFORM) {
    return res.status(405).json({
      data: null,
      error: { message: 'Not supported in platform mode' },
    })
  }

  if (!id) {
    return res.status(400).json({
      data: null,
      error: { message: 'Signing key ID is required' },
    })
  }

  try {
    // When the frontend sets status to "in_use", it means rotate the standby key to current.
    // Rotation is a project-level operation in TM — the `id` identifies which standby key
    // the frontend intends to promote, but TM rotates whichever key is in standby.
    if (status === 'in_use') {
      const { rotateKeys } = await import('lib/api/tenant-manager/jwt-keys')
      const result = await rotateKeys(ref as string)

      if (!result) {
        return res.status(500).json({
          data: null,
          error: { message: 'Failed to rotate signing keys' },
        })
      }

      // Return the newly promoted current key
      return res.status(200).json(result.current)
    }

    return res.status(400).json({
      data: null,
      error: { message: `Unsupported status transition: ${status}` },
    })
  } catch (error) {
    console.error('Failed to update signing key:', error)
    return res.status(500).json({
      data: null,
      error: { message: error instanceof Error ? error.message : 'Internal server error' },
    })
  }
}

const handleDelete = async (req: NextApiRequest, res: NextApiResponse) => {
  // TM does not support direct deletion of JWT keys; keys are managed through rotation
  return res.status(405).json({
    data: null,
    error: { message: 'JWT signing key deletion is not supported. Use key rotation instead.' },
  })
}
