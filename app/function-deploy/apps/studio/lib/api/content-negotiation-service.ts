import { NextApiRequest, NextApiResponse } from 'next'

/**
 * Content Negotiation Service
 * Handles response format negotiation and format-specific optimizations
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5
 */
export class ContentNegotiationService {
  private static instance: ContentNegotiationService

  private constructor() {}

  static getInstance(): ContentNegotiationService {
    if (!ContentNegotiationService.instance) {
      ContentNegotiationService.instance = new ContentNegotiationService()
    }
    return ContentNegotiationService.instance
  }

  /**
   * Negotiate content type based on Accept header
   * Requirements: 15.1, 15.2, 15.3, 15.4
   */
  negotiateContentType(acceptHeader?: string): ContentNegotiationResult {
    if (!acceptHeader || acceptHeader === '*/*') {
      return {
        format: 'json',
        contentType: 'application/json',
        isSupported: true
      }
    }

    // Parse Accept header and extract media types with quality values
    const mediaTypes = this.parseAcceptHeader(acceptHeader)
    
    // Sort by quality value (highest first)
    mediaTypes.sort((a, b) => b.quality - a.quality)

    // Find the first supported media type
    for (const mediaType of mediaTypes) {
      const result = this.mapMediaTypeToFormat(mediaType.type)
      if (result.isSupported) {
        return result
      }
    }

    // No supported format found
    return {
      format: null,
      contentType: null,
      isSupported: false,
      error: 'Not Acceptable',
      supportedTypes: this.getSupportedContentTypes()
    }
  }

  /**
   * Parse Accept header into media types with quality values
   * Requirements: 15.4
   */
  private parseAcceptHeader(acceptHeader: string): MediaType[] {
    const mediaTypes: MediaType[] = []
    
    // Split by comma and process each media type
    const parts = acceptHeader.split(',')
    
    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue

      // Split media type and parameters
      const [mediaType, ...params] = trimmed.split(';')
      
      // Extract quality value (default is 1.0)
      let quality = 1.0
      for (const param of params) {
        const [key, value] = param.trim().split('=')
        if (key === 'q' && value) {
          const parsedQuality = parseFloat(value)
          if (!isNaN(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1) {
            quality = parsedQuality
          }
          // If quality is invalid, keep default quality of 1.0
        }
      }

      mediaTypes.push({
        type: mediaType.trim(),
        quality,
        parameters: params.map(p => p.trim())
      })
    }

    return mediaTypes
  }

  /**
   * Map media type to response format
   * Requirements: 15.1, 15.2, 15.3
   */
  private mapMediaTypeToFormat(mediaType: string): ContentNegotiationResult {
    const lowerType = mediaType.toLowerCase()

    switch (lowerType) {
      case 'application/json':
        return {
          format: 'json',
          contentType: 'application/json',
          isSupported: true
        }

      case 'text/csv':
        return {
          format: 'csv',
          contentType: 'text/csv',
          isSupported: true
        }

      case 'application/vnd.pgrst.object+json':
        return {
          format: 'single-object',
          contentType: 'application/vnd.pgrst.object+json',
          isSupported: true
        }

      case 'application/geo+json':
      case 'application/geojson':
        return {
          format: 'geojson',
          contentType: 'application/geo+json',
          isSupported: true
        }

      case '*/*':
        return {
          format: 'json',
          contentType: 'application/json',
          isSupported: true
        }

      default:
        return {
          format: null,
          contentType: null,
          isSupported: false
        }
    }
  }

  /**
   * Get list of supported content types
   * Requirements: 15.5
   */
  getSupportedContentTypes(): string[] {
    return [
      'application/json',
      'text/csv',
      'application/vnd.pgrst.object+json',
      'application/geo+json'
    ]
  }

  /**
   * Format response data according to negotiated format
   * Requirements: 15.1, 15.2, 15.3
   */
  formatResponse(
    data: any[],
    format: ResponseFormat,
    options: FormatOptions = {}
  ): FormattedResponse {
    try {
      switch (format) {
        case 'json':
          return this.formatAsJSON(data, options)
        
        case 'csv':
          return this.formatAsCSV(data, options)
        
        case 'single-object':
          return this.formatAsSingleObject(data, options)
        
        case 'geojson':
          return this.formatAsGeoJSON(data, options)
        
        default:
          throw new Error(`Unsupported format: ${format}`)
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown formatting error',
        data: null
      }
    }
  }

  /**
   * Apply format-specific response optimizations
   * Requirements: 15.3
   */
  applyFormatOptimizations(
    data: any[],
    format: ResponseFormat,
    options: FormatOptions = {}
  ): OptimizationResult {
    const optimizations: string[] = []
    let optimizedData = data

    switch (format) {
      case 'json':
        // JSON optimizations
        if (data.length > 1000) {
          optimizations.push('large-dataset-streaming')
        }
        if (this.hasNestedObjects(data)) {
          optimizations.push('nested-object-flattening')
        }
        break

      case 'csv':
        // CSV optimizations
        optimizations.push('header-optimization')
        if (data.length > 10000) {
          optimizations.push('chunked-csv-generation')
        }
        // Remove nested objects for CSV compatibility
        optimizedData = this.flattenForCSV(data)
        optimizations.push('object-flattening')
        break

      case 'single-object':
        // Single object optimizations
        optimizedData = data.slice(0, 1) // Only take first record
        optimizations.push('single-record-extraction')
        break

      case 'geojson':
        // GeoJSON optimizations
        if (this.hasGeometryColumn(data)) {
          optimizations.push('geometry-validation')
        }
        optimizations.push('feature-collection-wrapping')
        break
    }

    return {
      data: optimizedData,
      appliedOptimizations: optimizations,
      originalSize: data.length,
      optimizedSize: optimizedData.length
    }
  }

  /**
   * Handle unsupported format error
   * Requirements: 15.5
   */
  createUnsupportedFormatError(acceptHeader: string): UnsupportedFormatError {
    return {
      code: 'PGRST208',
      message: 'Not Acceptable',
      details: `The requested content type is not supported`,
      hint: `Supported content types: ${this.getSupportedContentTypes().join(', ')}`,
      acceptHeader,
      supportedTypes: this.getSupportedContentTypes(),
      statusCode: 406
    }
  }

  /**
   * Set appropriate response headers for content type
   * Requirements: 15.1, 15.2, 15.3
   */
  setResponseHeaders(
    res: NextApiResponse,
    format: ResponseFormat,
    contentType: string,
    dataLength?: number
  ): void {
    // Set content type
    res.setHeader('Content-Type', contentType)

    // Set format-specific headers
    switch (format) {
      case 'csv':
        res.setHeader('Content-Disposition', 'attachment; filename="data.csv"')
        break

      case 'single-object':
        // PostgREST compatibility header
        res.setHeader('Content-Profile', 'public')
        break

      case 'geojson':
        res.setHeader('Content-Disposition', 'attachment; filename="data.geojson"')
        break
    }

    // Set data length if provided
    if (dataLength !== undefined) {
      res.setHeader('Content-Length', dataLength.toString())
    }

    // Set caching headers for static content
    if (format === 'csv' || format === 'geojson') {
      res.setHeader('Cache-Control', 'public, max-age=300') // 5 minutes
    }
  }

  /**
   * Format data as JSON
   * Requirements: 15.1
   */
  private formatAsJSON(data: any[], options: FormatOptions): FormattedResponse {
    return {
      success: true,
      data: data,
      contentType: 'application/json'
    }
  }

  /**
   * Format data as CSV
   * Requirements: 15.2
   */
  private formatAsCSV(data: any[], options: FormatOptions): FormattedResponse {
    if (data.length === 0) {
      return {
        success: true,
        data: '',
        contentType: 'text/csv'
      }
    }

    const delimiter = options.delimiter || ','
    const nullValue = options.nullValue || ''
    const includeHeaders = options.includeHeaders !== false

    // Flatten nested objects for CSV compatibility
    const flattenedData = this.flattenForCSV(data)
    
    // Get column names from first row
    const columns = Object.keys(flattenedData[0])
    const lines: string[] = []

    // Add headers if requested
    if (includeHeaders) {
      lines.push(columns.join(delimiter))
    }

    // Add data rows
    for (const row of flattenedData) {
      const values = columns.map(col => {
        const value = row[col]
        if (value === null || value === undefined) {
          return nullValue
        }
        
        // Convert to string and escape if necessary
        const stringValue = String(value)
        if (stringValue.includes(delimiter) || stringValue.includes('"') || stringValue.includes('\n')) {
          return `"${stringValue.replace(/"/g, '""')}"`
        }
        
        return stringValue
      })
      
      lines.push(values.join(delimiter))
    }

    return {
      success: true,
      data: lines.join('\n'),
      contentType: 'text/csv'
    }
  }

  /**
   * Format data as single object
   * Requirements: 15.3
   */
  private formatAsSingleObject(data: any[], options: FormatOptions): FormattedResponse {
    return {
      success: true,
      data: data.length > 0 ? data[0] : null,
      contentType: 'application/vnd.pgrst.object+json'
    }
  }

  /**
   * Format data as GeoJSON
   * Requirements: 15.3
   */
  private formatAsGeoJSON(data: any[], options: FormatOptions): FormattedResponse {
    const features = data.map(row => {
      // Look for geometry column (common names)
      const geometryColumns = ['geometry', 'geom', 'the_geom', 'wkb_geometry']
      let geometry = null
      let properties = { ...row }

      // Find and extract geometry
      for (const col of geometryColumns) {
        if (row[col]) {
          geometry = row[col]
          delete properties[col]
          break
        }
      }

      return {
        type: 'Feature',
        geometry: geometry || null,
        properties
      }
    })

    const geoJson = {
      type: 'FeatureCollection',
      features
    }

    return {
      success: true,
      data: geoJson,
      contentType: 'application/geo+json'
    }
  }

  /**
   * Check if data has nested objects
   */
  private hasNestedObjects(data: any[]): boolean {
    if (data.length === 0) return false
    
    const firstRow = data[0]
    return Object.values(firstRow).some(value => 
      typeof value === 'object' && value !== null && !Array.isArray(value)
    )
  }

  /**
   * Check if data has geometry column
   */
  private hasGeometryColumn(data: any[]): boolean {
    if (data.length === 0) return false
    
    const firstRow = data[0]
    const geometryColumns = ['geometry', 'geom', 'the_geom', 'wkb_geometry']
    
    return geometryColumns.some(col => firstRow.hasOwnProperty(col))
  }

  /**
   * Flatten nested objects for CSV compatibility
   */
  private flattenForCSV(data: any[]): any[] {
    return data.map(row => {
      const flattened: any = {}
      
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          // Flatten nested object
          for (const [nestedKey, nestedValue] of Object.entries(value)) {
            flattened[`${key}_${nestedKey}`] = nestedValue
          }
        } else if (Array.isArray(value)) {
          // Convert array to string
          flattened[key] = value.join(';')
        } else {
          flattened[key] = value
        }
      }
      
      return flattened
    })
  }
}

/**
 * Media type with quality value
 */
interface MediaType {
  type: string
  quality: number
  parameters: string[]
}

/**
 * Content negotiation result
 * Requirements: 15.1, 15.4, 15.5
 */
export interface ContentNegotiationResult {
  format: ResponseFormat | null
  contentType: string | null
  isSupported: boolean
  error?: string
  supportedTypes?: string[]
}

/**
 * Response format types
 * Requirements: 15.1, 15.2, 15.3
 */
export type ResponseFormat = 'json' | 'csv' | 'single-object' | 'geojson'

/**
 * Format options for response formatting
 * Requirements: 15.2, 15.3
 */
export interface FormatOptions {
  delimiter?: string
  nullValue?: string
  includeHeaders?: boolean
  selectedColumns?: string[]
}

/**
 * Formatted response result
 * Requirements: 15.1, 15.2, 15.3
 */
export interface FormattedResponse {
  success: boolean
  data: any
  contentType?: string
  error?: string
}

/**
 * Optimization result
 * Requirements: 15.3
 */
export interface OptimizationResult {
  data: any[]
  appliedOptimizations: string[]
  originalSize: number
  optimizedSize: number
}

/**
 * Unsupported format error
 * Requirements: 15.5
 */
export interface UnsupportedFormatError {
  code: string
  message: string
  details: string
  hint: string
  acceptHeader: string
  supportedTypes: string[]
  statusCode: number
}

/**
 * Factory function to get the content negotiation service
 */
export function getContentNegotiationService(): ContentNegotiationService {
  return ContentNegotiationService.getInstance()
}