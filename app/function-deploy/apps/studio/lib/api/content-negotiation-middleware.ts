import { NextApiRequest, NextApiResponse } from 'next'
import { getContentNegotiationService } from './content-negotiation-service'

/**
 * Content Negotiation Middleware
 * Handles Accept header validation and content type negotiation
 * Requirements: 15.1, 15.4, 15.5
 */
export function withContentNegotiation() {
  return (req: NextApiRequest, res: NextApiResponse, next: () => void) => {
    const contentNegotiationService = getContentNegotiationService()
    
    // Skip content negotiation for non-GET requests that don't expect formatted responses
    if (req.method !== 'GET' && req.method !== 'POST') {
      return next()
    }

    // Skip if no Accept header (will default to JSON)
    const acceptHeader = req.headers.accept
    if (!acceptHeader || acceptHeader === '*/*') {
      return next()
    }

    // Negotiate content type
    const negotiationResult = contentNegotiationService.negotiateContentType(acceptHeader)
    
    if (!negotiationResult.isSupported) {
      const error = contentNegotiationService.createUnsupportedFormatError(acceptHeader)
      
      return res.status(error.statusCode).json({
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
        supported_types: error.supportedTypes
      })
    }

    // Store negotiation result in request for later use
    ;(req as any).contentNegotiation = negotiationResult
    
    next()
  }
}

/**
 * Enhanced response helper that applies content negotiation
 * Requirements: 15.1, 15.2, 15.3
 */
export function sendNegotiatedResponse(
  req: NextApiRequest,
  res: NextApiResponse,
  data: any[],
  options: {
    tableName?: string
    totalCount?: number
    limit?: number
    offset?: number
  } = {}
) {
  const contentNegotiationService = getContentNegotiationService()
  
  // Get negotiation result from middleware or negotiate now
  const negotiationResult = (req as any).contentNegotiation || 
    contentNegotiationService.negotiateContentType(req.headers.accept)

  if (!negotiationResult.isSupported) {
    const error = contentNegotiationService.createUnsupportedFormatError(req.headers.accept || '')
    return res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    })
  }

  // Apply format-specific optimizations
  const optimizationResult = contentNegotiationService.applyFormatOptimizations(
    data,
    negotiationResult.format!
  )

  // Format the response
  const formatResult = contentNegotiationService.formatResponse(
    optimizationResult.data,
    negotiationResult.format!
  )

  if (!formatResult.success) {
    return res.status(500).json({
      code: 'PGRST000',
      message: 'Response formatting failed',
      details: formatResult.error,
      hint: 'Check server logs for more details'
    })
  }

  // Set appropriate response headers
  contentNegotiationService.setResponseHeaders(
    res,
    negotiationResult.format!,
    negotiationResult.contentType!,
    typeof formatResult.data === 'string' ? formatResult.data.length : undefined
  )

  // Add metadata headers
  res.setHeader('X-Response-Format', negotiationResult.format!)
  res.setHeader('X-Original-Rows', data.length.toString())
  res.setHeader('X-Optimized-Rows', optimizationResult.optimizedSize.toString())
  
  if (optimizationResult.appliedOptimizations.length > 0) {
    res.setHeader('X-Applied-Optimizations', optimizationResult.appliedOptimizations.join(','))
  }

  // Add pagination headers if provided
  if (options.totalCount !== undefined || options.limit !== undefined || options.offset !== undefined) {
    const start = options.offset || 0
    const end = start + optimizationResult.optimizedSize - 1
    
    if (options.totalCount !== undefined) {
      res.setHeader('Content-Range', `${start}-${end}/${options.totalCount}`)
    } else {
      res.setHeader('Content-Range', `${start}-${end}/*`)
    }
  }

  // Send the formatted response
  if (negotiationResult.format === 'csv') {
    res.status(200).send(formatResult.data)
  } else {
    res.status(200).json(formatResult.data)
  }
}

/**
 * Type guard to check if request has content negotiation result
 */
export function hasContentNegotiation(req: NextApiRequest): boolean {
  return !!(req as any).contentNegotiation
}

/**
 * Get content negotiation result from request
 */
export function getContentNegotiationResult(req: NextApiRequest) {
  return (req as any).contentNegotiation
}