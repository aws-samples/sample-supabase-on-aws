import type { NextApiRequest, NextApiResponse } from 'next'

import { ResponseError, ResponseFailure } from 'types'

// Use environment variable directly to avoid importing browser-dependent code
const IS_PLATFORM = process.env.NEXT_PUBLIC_IS_PLATFORM === 'true'

export function isResponseOk<T>(response: T | ResponseFailure | undefined): response is T {
  if (response === undefined || response === null) {
    return false
  }

  if (response instanceof ResponseError) {
    return false
  }

  if (typeof response === 'object' && 'error' in response && Boolean(response.error)) {
    return false
  }

  return true
}

// Purpose of this apiWrapper is to function like a global catchall for ANY errors
// It's a safety net as the API service should never drop, nor fail

export default async function apiWrapper(
  req: NextApiRequest,
  res: NextApiResponse,
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<Response | void>,
  options?: { withAuth: boolean }
): Promise<Response | void> {
  try {
    const { withAuth } = options || {}

    if (IS_PLATFORM && withAuth) {
      // Dynamically import apiAuthenticate only when needed to avoid loading browser-dependent code
      const { apiAuthenticate } = await import('./apiAuthenticate')
      const response = await apiAuthenticate(req, res)
      if (!isResponseOk(response)) {
        return res.status(401).json({
          error: {
            message: `Unauthorized: ${response.error.message}`,
          },
        })
      }
    }

    return handler(req, res)
  } catch (error) {
    console.error('API Error:', error)
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred'
    const errorStack = error instanceof Error ? error.stack : undefined
    
    return res.status(500).json({ 
      error: {
        message: errorMessage,
        ...(process.env.NODE_ENV === 'development' && errorStack && { stack: errorStack })
      }
    })
  }
}
