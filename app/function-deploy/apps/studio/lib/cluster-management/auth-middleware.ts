import type { JwtPayload } from '@supabase/supabase-js'
import { getUserClaims } from 'lib/gotrue'
import type { NextApiRequest, NextApiResponse } from 'next'
import { createHmac } from 'crypto'

export interface AuthenticatedRequest extends NextApiRequest {
  user?: JwtPayload
}

/**
 * Verify JWT token manually using HMAC-SHA256
 */
function verifyJWT(token: string, secret: string): JwtPayload | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return null
    }

    const [headerB64, payloadB64, signatureB64] = parts
    
    // Verify signature
    const data = `${headerB64}.${payloadB64}`
    const signature = createHmac('sha256', secret)
      .update(data)
      .digest('base64url')
    
    if (signature !== signatureB64) {
      return null
    }

    // Decode payload
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf-8')
    )

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null
    }

    return payload as JwtPayload
  } catch (error) {
    console.error('JWT verification error:', error)
    return null
  }
}

/**
 * Authentication middleware for cluster management API endpoints.
 * Verifies JWT tokens or session cookies and extracts user identity.
 * 
 * Requirements: 13.1, 13.3
 * 
 * @param req - Next.js API request
 * @param res - Next.js API response
 * @returns User claims if authenticated, or sends 401 response
 */
export async function authenticateClusterRequest(
  req: AuthenticatedRequest,
  res: NextApiResponse
): Promise<JwtPayload | null> {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization
    if (!authHeader) {
      res.status(401).json({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Missing authentication token',
        },
      })
      return null
    }

    // Remove 'Bearer ' prefix if present
    const token = authHeader.replace(/^bearer\s+/i, '')
    if (!token) {
      res.status(401).json({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Invalid authentication token format',
        },
      })
      return null
    }

    // First, try to verify JWT directly with JWT_SECRET
    // This allows service_role key to work
    const jwtSecret = process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET
    if (jwtSecret) {
      const decoded = verifyJWT(token, jwtSecret)
      
      if (decoded && decoded.role === 'service_role') {
        // Service role has full admin access
        req.user = decoded
        return decoded
      }
      
      // For other roles, continue with normal GoTrue verification
    }

    // Verify JWT token and get user claims via GoTrue
    const { claims, error } = await getUserClaims(token)
    
    if (error || !claims) {
      res.status(401).json({
        error: {
          code: 'AUTHENTICATION_FAILED',
          message: 'Invalid or expired authentication token',
        },
      })
      return null
    }

    // Attach user to request for downstream handlers
    req.user = claims

    return claims
  } catch (error) {
    console.error('Authentication error:', error)
    res.status(401).json({
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: 'Authentication failed',
      },
    })
    return null
  }
}
