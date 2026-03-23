import { NextApiRequest, NextApiResponse } from 'next'

import { fetchGet } from 'data/fetchers'
import { ensureConnectionEncrypted } from 'lib/api/self-hosted/pgMetaHeaders'
import apiWrapper from 'lib/api/apiWrapper'
import { getPgMetaRedirectUrl } from './tables'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const { ref } = req.query
  const headers = await ensureConnectionEncrypted(req.headers, ref as string)
  const response = await fetchGet(getPgMetaRedirectUrl(req, 'foreign-tables'), { headers })

  if (response.error) {
    const { code, message } = response.error
    return res.status(code).json({ message })
  } else {
    return res.status(200).json(response)
  }
}
