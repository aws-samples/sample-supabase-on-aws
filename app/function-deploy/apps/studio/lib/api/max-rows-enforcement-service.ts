/**
 * Service for enforcing max rows limits and adding pagination headers
 * Implements Requirements 5.2, 5.3 for max rows enforcement
 */

export interface PaginationHeaders {
  'Content-Range': string
  'X-Total-Count': string
  'Accept-Ranges': string
}

export interface QueryResult<T = any> {
  data: T[]
  totalCount: number
  hasMore: boolean
}

export interface MaxRowsEnforcementOptions {
  maxRows: number
  offset?: number
  totalCount?: number
}

/**
 * Service for enforcing max rows limits on API responses
 */
export class MaxRowsEnforcementService {
  /**
   * Enforce max rows limit on query results and generate pagination headers
   */
  static enforceMaxRows<T>(
    results: T[], 
    options: MaxRowsEnforcementOptions
  ): { 
    limitedResults: T[], 
    headers: PaginationHeaders,
    hasMore: boolean 
  } {
    const { maxRows, offset = 0, totalCount } = options
    
    // Validate max rows parameter
    if (maxRows < 1 || maxRows > 1000000) {
      throw new Error('Max rows must be between 1 and 1,000,000')
    }
    
    // Limit results to max rows
    const limitedResults = results.slice(0, maxRows)
    const actualCount = limitedResults.length
    const hasMore = results.length > maxRows
    
    // Calculate total count (use provided totalCount or estimate from results)
    const estimatedTotal = totalCount ?? (hasMore ? offset + results.length + 1 : offset + actualCount)
    
    // Generate pagination headers
    const headers = this.generatePaginationHeaders({
      offset,
      limit: maxRows,
      actualCount,
      totalCount: estimatedTotal,
      hasMore
    })
    
    return {
      limitedResults,
      headers,
      hasMore
    }
  }
  
  /**
   * Generate standard pagination headers for API responses
   */
  private static generatePaginationHeaders(params: {
    offset: number
    limit: number
    actualCount: number
    totalCount: number
    hasMore: boolean
  }): PaginationHeaders {
    const { offset, limit, actualCount, totalCount, hasMore } = params
    
    // Content-Range header format: "items start-end/total"
    const start = offset
    const end = offset + actualCount - 1
    const contentRange = actualCount > 0 
      ? `items ${start}-${end}/${hasMore ? '*' : totalCount}`
      : `items */${totalCount}`
    
    return {
      'Content-Range': contentRange,
      'X-Total-Count': totalCount.toString(),
      'Accept-Ranges': 'items'
    }
  }
  
  /**
   * Apply max rows enforcement to API response
   */
  static applyMaxRowsToResponse(
    res: any, 
    data: any[], 
    options: MaxRowsEnforcementOptions
  ): any[] {
    const { limitedResults, headers } = this.enforceMaxRows(data, options)
    
    // Set pagination headers
    Object.entries(headers).forEach(([key, value]) => {
      res.setHeader(key, value)
    })
    
    return limitedResults
  }
  
  /**
   * Parse pagination parameters from request query
   */
  static parsePaginationParams(query: any): { offset: number, limit?: number } {
    const offset = Math.max(0, parseInt(query.offset as string) || 0)
    const limit = query.limit ? Math.max(1, parseInt(query.limit as string)) : undefined
    
    return { offset, limit }
  }
  
  /**
   * Validate max rows configuration
   */
  static validateMaxRowsConfig(maxRows: number): void {
    if (!Number.isInteger(maxRows)) {
      throw new Error('Max rows must be a whole number')
    }
    
    if (maxRows < 1) {
      throw new Error('Max rows must be at least 1')
    }
    
    if (maxRows > 1000000) {
      throw new Error("Max rows can't be more than 1,000,000")
    }
  }
  
  /**
   * Get default max rows value
   */
  static getDefaultMaxRows(): number {
    return parseInt(process.env.PGRST_DB_MAX_ROWS || '1000', 10)
  }
}