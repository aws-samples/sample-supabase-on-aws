import { NextApiRequest } from 'next'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { getProjectDatabaseClient } from './project-database-client'

/**
 * Full-Text Search Service
 * Handles PostgreSQL full-text search operations for PostgREST
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */
export class FullTextSearchService {
  private static instance: FullTextSearchService

  private constructor() {}

  static getInstance(): FullTextSearchService {
    if (!FullTextSearchService.instance) {
      FullTextSearchService.instance = new FullTextSearchService()
    }
    return FullTextSearchService.instance
  }

  /**
   * Parse full-text search operators from query parameters
   * Requirements: 4.1, 4.2, 4.3, 4.4
   */
  parseFullTextSearchOperators(query: Record<string, any>): FullTextSearchFilter[] {
    const ftsFilters: FullTextSearchFilter[] = []

    for (const [key, value] of Object.entries(query)) {
      // Skip non-filter parameters (including Next.js route parameters)
      if (['select', 'order', 'limit', 'offset', 'count', 'schema', 'path', 'ref'].includes(key)) {
        continue
      }

      // Parse FTS operators - look for patterns like:
      // column.fts, column.plfts, column.phfts, column.wfts
      const parts = key.split('.')
      if (parts.length >= 2) {
        const column = parts[0]
        const operator = parts[1]
        
        if (this.isFullTextSearchOperator(operator)) {
          const ftsFilter = this.parseFullTextSearchFilter(column, operator, value, parts.slice(2))
          if (ftsFilter) {
            ftsFilters.push(ftsFilter)
          }
        }
      }
    }

    return ftsFilters
  }

  /**
   * Check if an operator is a full-text search operator
   * Requirements: 4.1, 4.2, 4.3, 4.4
   */
  private isFullTextSearchOperator(operator: string): boolean {
    const ftsOperators = ['fts', 'plfts', 'phfts', 'wfts']
    return ftsOperators.includes(operator)
  }

  /**
   * Parse a single full-text search filter
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
   */
  private parseFullTextSearchFilter(
    column: string,
    operator: string,
    value: any,
    configParts: string[]
  ): FullTextSearchFilter | null {
    try {
      // Validate column name
      if (!this.isValidColumnName(column)) {
        throw new Error(`Invalid column name: ${column}`)
      }

      // Validate search term
      if (!value || typeof value !== 'string') {
        throw new Error('Full-text search term must be a non-empty string')
      }

      // Parse text search configuration if provided
      let config: string | null = null
      if (configParts.length > 0) {
        config = configParts[0] // First part after operator is the config
        if (!this.isValidTextSearchConfig(config)) {
          console.warn(`Invalid text search configuration: ${config}, using default`)
          config = null
        }
      }

      return {
        column,
        operator: operator as FullTextSearchOperator,
        searchTerm: value.toString(),
        config,
        rawValue: value
      }
    } catch (error) {
      console.error(`Error parsing full-text search filter for ${column}.${operator}:`, error)
      return null
    }
  }

  /**
   * Validate text search configuration
   * Requirements: 4.5
   */
  private isValidTextSearchConfig(config: string): boolean {
    // Common PostgreSQL text search configurations
    const validConfigs = [
      'simple', 'english', 'spanish', 'french', 'german', 'italian', 'portuguese',
      'russian', 'arabic', 'danish', 'dutch', 'finnish', 'hungarian', 'norwegian',
      'romanian', 'swedish', 'turkish'
    ]
    return validConfigs.includes(config.toLowerCase())
  }

  /**
   * Build SQL WHERE clause for full-text search filters
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
   */
  buildFullTextSearchWhereClause(filters: FullTextSearchFilter[]): { clause: string; params: any[] } {
    if (filters.length === 0) {
      return { clause: '', params: [] }
    }

    const conditions: string[] = []
    const params: any[] = []
    let paramIndex = 1

    for (const filter of filters) {
      try {
        const condition = this.buildSingleFullTextSearchCondition(filter, paramIndex)
        if (condition) {
          conditions.push(condition.clause)
          params.push(...condition.params)
          paramIndex += condition.params.length
        }
      } catch (error) {
        console.error(`Error building full-text search condition for ${filter.column}.${filter.operator}:`, error)
        // Skip invalid filters rather than failing the entire query
        continue
      }
    }

    if (conditions.length === 0) {
      return { clause: '', params: [] }
    }

    return {
      clause: conditions.join(' AND '),
      params
    }
  }

  /**
   * Build SQL condition for a single full-text search filter
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
   */
  private buildSingleFullTextSearchCondition(
    filter: FullTextSearchFilter,
    paramIndex: number
  ): { clause: string; params: any[] } | null {
    const { column, operator, searchTerm, config } = filter

    // Build the column reference
    const columnRef = this.escapeIdentifier(column)
    
    // Build the text search configuration
    const configRef = config ? `'${config}'::regconfig` : 'to_regconfig(\'english\')'

    switch (operator) {
      case 'fts':
        // Full-text search using to_tsvector and to_tsquery
        return {
          clause: `to_tsvector(${configRef}, ${columnRef}) @@ to_tsquery(${configRef}, $${paramIndex})`,
          params: [this.sanitizeSearchTerm(searchTerm)]
        }

      case 'plfts':
        // Phrase-level full-text search using plainto_tsquery
        return {
          clause: `to_tsvector(${configRef}, ${columnRef}) @@ plainto_tsquery(${configRef}, $${paramIndex})`,
          params: [searchTerm]
        }

      case 'phfts':
        // Phrase full-text search using phraseto_tsquery
        return {
          clause: `to_tsvector(${configRef}, ${columnRef}) @@ phraseto_tsquery(${configRef}, $${paramIndex})`,
          params: [searchTerm]
        }

      case 'wfts':
        // Websearch-style full-text search using websearch_to_tsquery
        return {
          clause: `to_tsvector(${configRef}, ${columnRef}) @@ websearch_to_tsquery(${configRef}, $${paramIndex})`,
          params: [searchTerm]
        }

      default:
        console.warn(`Unsupported full-text search operator: ${operator}`)
        return null
    }
  }

  /**
   * Sanitize search term for to_tsquery
   * Requirements: 4.1, 4.5
   */
  private sanitizeSearchTerm(searchTerm: string): string {
    // For to_tsquery, we need to handle special characters and operators
    // Replace spaces with & (AND operator) and escape special characters
    return searchTerm
      .replace(/[&|!()]/g, ' ') // Remove tsquery operators to prevent injection
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()
      .split(' ')
      .filter(term => term.length > 0)
      .join(' & ') // Join with AND operator
  }

  /**
   * Execute full-text search query
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
   */
  async executeFullTextSearchQuery(
    context: ProjectIsolationContext,
    tableName: string,
    ftsFilters: FullTextSearchFilter[],
    selectColumns?: string[],
    orderBy?: string,
    limit?: number,
    offset?: number,
    includeRanking?: boolean
  ): Promise<FullTextSearchResult> {
    const startTime = Date.now()

    try {
      // Validate table name
      if (!this.isValidTableName(tableName)) {
        throw new Error(`Invalid table name: ${tableName}`)
      }

      // Check for unindexed columns and issue performance warnings
      const performanceWarnings = await this.checkForUnindexedColumns(context, tableName, ftsFilters)

      // Build the query
      let selectClause = selectColumns && selectColumns.length > 0 
        ? selectColumns.map(col => this.escapeIdentifier(col)).join(', ')
        : '*'

      // Add ranking if requested and we have FTS filters
      if (includeRanking && ftsFilters.length > 0) {
        const rankingClause = this.buildRankingClause(ftsFilters)
        if (rankingClause) {
          selectClause += `, ${rankingClause} as ts_rank`
        }
      }

      let query = `SELECT ${selectClause} FROM ${this.escapeIdentifier(tableName)}`

      // Add full-text search WHERE clause
      const whereClause = this.buildFullTextSearchWhereClause(ftsFilters)
      const params = whereClause.params

      if (whereClause.clause) {
        query += ` WHERE ${whereClause.clause}`
      }

      // Add ORDER BY clause (default to ranking if FTS and no explicit order)
      if (orderBy) {
        const sanitizedOrderBy = this.sanitizeOrderBy(orderBy)
        if (sanitizedOrderBy) {
          query += ` ORDER BY ${sanitizedOrderBy}`
        }
      } else if (includeRanking && ftsFilters.length > 0) {
        query += ` ORDER BY ts_rank DESC`
      }

      // Add LIMIT and OFFSET
      if (limit && limit > 0) {
        query += ` LIMIT ${Math.min(limit, 1000)}` // Cap at 1000 for safety
      }

      if (offset && offset > 0) {
        query += ` OFFSET ${offset}`
      }

      // Execute the query
      const projectDbClient = getProjectDatabaseClient()
      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query,
        params
      )

      const executionTime = Date.now() - startTime

      return {
        success: true,
        data: result.rows,
        rowCount: result.rowCount || 0,
        executionTime,
        performanceWarnings,
        query: {
          sql: query,
          params,
          ftsFilters
        }
      }
    } catch (error) {
      const executionTime = Date.now() - startTime
      console.error('Full-text search query execution failed:', error)

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTime,
        query: {
          ftsFilters
        }
      }
    }
  }

  /**
   * Build ranking clause for full-text search results
   * Requirements: 4.1, 4.2, 4.3, 4.4
   */
  private buildRankingClause(filters: FullTextSearchFilter[]): string | null {
    if (filters.length === 0) return null

    // Use the first filter for ranking (could be enhanced to combine multiple filters)
    const filter = filters[0]
    const columnRef = this.escapeIdentifier(filter.column)
    const configRef = filter.config ? `'${filter.config}'::regconfig` : 'to_regconfig(\'english\')'

    switch (filter.operator) {
      case 'fts':
        return `ts_rank(to_tsvector(${configRef}, ${columnRef}), to_tsquery(${configRef}, '${this.sanitizeSearchTerm(filter.searchTerm)}'))`
      case 'plfts':
        return `ts_rank(to_tsvector(${configRef}, ${columnRef}), plainto_tsquery(${configRef}, '${filter.searchTerm}'))`
      case 'phfts':
        return `ts_rank(to_tsvector(${configRef}, ${columnRef}), phraseto_tsquery(${configRef}, '${filter.searchTerm}'))`
      case 'wfts':
        return `ts_rank(to_tsvector(${configRef}, ${columnRef}), websearch_to_tsquery(${configRef}, '${filter.searchTerm}'))`
      default:
        return null
    }
  }

  /**
   * Check for unindexed columns and return performance warnings
   * Requirements: 4.5
   */
  private async checkForUnindexedColumns(
    context: ProjectIsolationContext,
    tableName: string,
    filters: FullTextSearchFilter[]
  ): Promise<string[]> {
    const warnings: string[] = []

    try {
      const projectDbClient = getProjectDatabaseClient()
      
      for (const filter of filters) {
        // Check if there's a GIN index on the column for full-text search
        const indexQuery = `
          SELECT i.indexname, i.indexdef
          FROM pg_indexes i
          WHERE i.tablename = $1 
            AND i.indexdef ILIKE '%gin%'
            AND (i.indexdef ILIKE '%to_tsvector%' OR i.indexdef ILIKE '%' || $2 || '%')
        `
        
        const indexResult = await projectDbClient.queryProjectDatabase(
          context.projectRef,
          context.userId,
          indexQuery,
          [tableName, filter.column]
        )
        
        if (indexResult.rowCount === 0) {
          warnings.push(
            `Column "${filter.column}" does not have a full-text search index. ` +
            `Consider creating a GIN index: CREATE INDEX ON ${tableName} USING gin(to_tsvector('english', ${filter.column}))`
          )
        }
      }
    } catch (error) {
      console.error('Error checking for full-text search indexes:', error)
      // Don't fail the query for index checking errors
    }

    return warnings
  }

  /**
   * Validate column name
   */
  private isValidColumnName(name: string): boolean {
    if (!name || typeof name !== 'string') return false
    // Allow alphanumeric, underscore, and dollar sign (common in PostgreSQL)
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
  }

  /**
   * Validate table name
   */
  private isValidTableName(name: string): boolean {
    if (!name || typeof name !== 'string') return false
    // Allow alphanumeric, underscore, and dollar sign (common in PostgreSQL)
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
  }

  /**
   * Escape SQL identifier
   */
  private escapeIdentifier(identifier: string): string {
    // Use double quotes to escape PostgreSQL identifiers
    return `"${identifier.replace(/"/g, '""')}"`
  }

  /**
   * Sanitize ORDER BY clause
   */
  private sanitizeOrderBy(orderBy: string): string | null {
    try {
      // Parse and validate ORDER BY clause
      const parts = orderBy.split(',').map(part => part.trim())
      const sanitizedParts: string[] = []

      for (const part of parts) {
        const match = part.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\s*(ASC|DESC)?$/i)
        if (match) {
          const column = match[1]
          const direction = match[2] ? match[2].toUpperCase() : 'ASC'
          sanitizedParts.push(`${this.escapeIdentifier(column)} ${direction}`)
        }
      }

      return sanitizedParts.length > 0 ? sanitizedParts.join(', ') : null
    } catch (error) {
      console.error('Error sanitizing ORDER BY clause:', error)
      return null
    }
  }

  /**
   * Get supported full-text search operators
   */
  getSupportedOperators(): FullTextSearchOperatorInfo[] {
    return [
      {
        operator: 'fts',
        description: 'Full-text search using to_tsquery (supports operators like &, |, !)',
        example: 'content.fts=search&term',
        configSupport: true,
        performanceNote: 'Best performance with GIN index on to_tsvector(column)'
      },
      {
        operator: 'plfts',
        description: 'Phrase-level full-text search using plainto_tsquery (treats input as plain text)',
        example: 'content.plfts=search term',
        configSupport: true,
        performanceNote: 'Good for user-friendly search input'
      },
      {
        operator: 'phfts',
        description: 'Phrase full-text search using phraseto_tsquery (searches for exact phrases)',
        example: 'content.phfts=exact phrase',
        configSupport: true,
        performanceNote: 'Most restrictive, good for exact phrase matching'
      },
      {
        operator: 'wfts',
        description: 'Websearch-style full-text search using websearch_to_tsquery (supports quotes, +, -)',
        example: 'content.wfts="exact phrase" +required -excluded',
        configSupport: true,
        performanceNote: 'User-friendly syntax similar to web search engines'
      }
    ]
  }

  /**
   * Get available text search configurations
   */
  async getAvailableConfigurations(context: ProjectIsolationContext): Promise<TextSearchConfiguration[]> {
    try {
      const projectDbClient = getProjectDatabaseClient()
      const query = `
        SELECT cfgname, cfgowner, cfgparser, oid
        FROM pg_ts_config
        ORDER BY cfgname
      `
      
      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query
      )
      
      return result.rows.map((row: any) => ({
        name: row.cfgname,
        owner: row.cfgowner,
        parser: row.cfgparser,
        oid: row.oid,
        description: this.getConfigurationDescription(row.cfgname)
      }))
    } catch (error) {
      console.error('Error fetching text search configurations:', error)
      return []
    }
  }

  /**
   * Get description for text search configuration
   */
  private getConfigurationDescription(configName: string): string {
    const descriptions: Record<string, string> = {
      'simple': 'Simple configuration with no stemming or stop words',
      'english': 'English language configuration with stemming and stop words',
      'spanish': 'Spanish language configuration',
      'french': 'French language configuration',
      'german': 'German language configuration',
      'italian': 'Italian language configuration',
      'portuguese': 'Portuguese language configuration',
      'russian': 'Russian language configuration',
      'arabic': 'Arabic language configuration',
      'danish': 'Danish language configuration',
      'dutch': 'Dutch language configuration',
      'finnish': 'Finnish language configuration',
      'hungarian': 'Hungarian language configuration',
      'norwegian': 'Norwegian language configuration',
      'romanian': 'Romanian language configuration',
      'swedish': 'Swedish language configuration',
      'turkish': 'Turkish language configuration'
    }
    
    return descriptions[configName.toLowerCase()] || `${configName} language configuration`
  }
}

/**
 * Full-text search filter interface
 */
export interface FullTextSearchFilter {
  column: string
  operator: FullTextSearchOperator
  searchTerm: string
  config?: string | null
  rawValue?: any
}

/**
 * Full-text search operators
 */
export type FullTextSearchOperator = 'fts' | 'plfts' | 'phfts' | 'wfts'

/**
 * Full-text search result interface
 */
export interface FullTextSearchResult {
  success: boolean
  data?: any[]
  rowCount?: number
  executionTime: number
  performanceWarnings?: string[]
  error?: string
  query: {
    sql?: string
    params?: any[]
    ftsFilters: FullTextSearchFilter[]
  }
}

/**
 * Full-text search operator information
 */
export interface FullTextSearchOperatorInfo {
  operator: FullTextSearchOperator
  description: string
  example: string
  configSupport: boolean
  performanceNote: string
}

/**
 * Text search configuration interface
 */
export interface TextSearchConfiguration {
  name: string
  owner: number
  parser: number
  oid: number
  description: string
}

/**
 * Factory function to get the full-text search service
 */
export function getFullTextSearchService(): FullTextSearchService {
  return FullTextSearchService.getInstance()
}