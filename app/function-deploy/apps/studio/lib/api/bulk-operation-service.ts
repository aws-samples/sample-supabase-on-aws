import { NextApiRequest } from 'next'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { getProjectDatabaseClient } from './project-database-client'

/**
 * Bulk Operation Service
 * Handles bulk insert and update operations for PostgREST
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */
export class BulkOperationService {
  private static instance: BulkOperationService
  private readonly DEFAULT_CHUNK_SIZE = 100
  private readonly MAX_CHUNK_SIZE = 1000
  private readonly MAX_BULK_SIZE = 10000

  private constructor() {}

  static getInstance(): BulkOperationService {
    if (!BulkOperationService.instance) {
      BulkOperationService.instance = new BulkOperationService()
    }
    return BulkOperationService.instance
  }

  /**
   * Detect if request is a bulk operation
   * Requirements: 8.1, 8.2
   */
  isBulkOperation(req: NextApiRequest): boolean {
    if (req.method !== 'POST' && req.method !== 'PATCH') {
      return false
    }

    // Check if body is an array (bulk operation)
    return Array.isArray(req.body) && req.body.length > 1
  }

  /**
   * Validate bulk operation request
   * Requirements: 8.1, 8.2, 8.3
   */
  validateBulkOperation(operation: BulkOperation): BulkValidationResult {
    const errors: string[] = []

    // Validate operation type
    if (!['insert', 'update'].includes(operation.type)) {
      errors.push(`Invalid operation type: ${operation.type}`)
    }

    // Validate table name
    if (!operation.tableName || !this.isValidTableName(operation.tableName)) {
      errors.push(`Invalid table name: ${operation.tableName}`)
    }

    // Validate records array
    if (!Array.isArray(operation.records) || operation.records.length === 0) {
      errors.push('Records array is required and must not be empty')
    }

    // Check bulk size limits
    if (operation.records.length > this.MAX_BULK_SIZE) {
      errors.push(`Bulk operation exceeds maximum size of ${this.MAX_BULK_SIZE} records`)
    }

    // Validate chunk size
    if (operation.chunkSize && (operation.chunkSize < 1 || operation.chunkSize > this.MAX_CHUNK_SIZE)) {
      errors.push(`Chunk size must be between 1 and ${this.MAX_CHUNK_SIZE}`)
    }

    // Validate individual records
    const recordErrors: RecordValidationError[] = []
    for (let i = 0; i < Math.min(operation.records.length, 10); i++) { // Validate first 10 records
      const record = operation.records[i]
      if (!record || typeof record !== 'object') {
        recordErrors.push({
          index: i,
          error: 'Record must be a non-null object'
        })
      } else if (Object.keys(record).length === 0) {
        recordErrors.push({
          index: i,
          error: 'Record cannot be empty'
        })
      }
    }

    return {
      isValid: errors.length === 0 && recordErrors.length === 0,
      errors,
      recordErrors
    }
  }

  /**
   * Execute bulk insert operation
   * Requirements: 8.1, 8.3, 8.4, 8.5
   */
  async executeBulkInsert(
    context: ProjectIsolationContext,
    tableName: string,
    records: Record<string, any>[],
    options: BulkInsertOptions = {}
  ): Promise<BulkInsertResult> {
    const startTime = Date.now()
    const chunkSize = Math.min(options.chunkSize || this.DEFAULT_CHUNK_SIZE, this.MAX_CHUNK_SIZE)
    const schema = options.schema || 'public'

    try {
      // Validate operation
      const validation = this.validateBulkOperation({
        type: 'insert',
        tableName,
        records,
        chunkSize
      })

      if (!validation.isValid) {
        throw new Error(`Bulk insert validation failed: ${validation.errors.join(', ')}`)
      }

      const client = getProjectDatabaseClient()
      const chunks = this.chunkArray(records, chunkSize)
      const results: BulkChunkResult[] = []
      let totalInserted = 0
      const failedRecords: FailedRecord[] = []

      // Process chunks sequentially to avoid overwhelming the database
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex]
        
        try {
          const chunkResult = await this.insertChunk(
            context,
            client,
            tableName,
            chunk,
            schema,
            chunkIndex * chunkSize,
            options
          )

          results.push(chunkResult)
          totalInserted += chunkResult.insertedCount
          failedRecords.push(...chunkResult.failedRecords)

        } catch (error) {
          // Handle chunk failure
          const chunkResult: BulkChunkResult = {
            chunkIndex,
            startIndex: chunkIndex * chunkSize,
            insertedCount: 0,
            failedRecords: chunk.map((record, index) => ({
              record,
              error: error instanceof Error ? error.message : 'Unknown error',
              index: chunkIndex * chunkSize + index
            }))
          }

          results.push(chunkResult)
          failedRecords.push(...chunkResult.failedRecords)
        }
      }

      const executionTime = Date.now() - startTime

      return {
        success: failedRecords.length === 0,
        totalRecords: records.length,
        insertedCount: totalInserted,
        failedCount: failedRecords.length,
        failedRecords,
        executionTime,
        chunks: results,
        summary: {
          totalChunks: chunks.length,
          successfulChunks: results.filter(r => r.failedRecords.length === 0).length,
          partialChunks: results.filter(r => r.failedRecords.length > 0 && r.insertedCount > 0).length,
          failedChunks: results.filter(r => r.insertedCount === 0).length
        }
      }

    } catch (error) {
      const executionTime = Date.now() - startTime
      console.error('Bulk insert operation failed:', error)

      return {
        success: false,
        totalRecords: records.length,
        insertedCount: 0,
        failedCount: records.length,
        failedRecords: records.map((record, index) => ({
          record,
          error: error instanceof Error ? error.message : 'Unknown error',
          index
        })),
        executionTime,
        chunks: [],
        summary: {
          totalChunks: 0,
          successfulChunks: 0,
          partialChunks: 0,
          failedChunks: 1
        },
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Execute bulk update operation
   * Requirements: 8.2, 8.3, 8.4, 8.5
   */
  async executeBulkUpdate(
    context: ProjectIsolationContext,
    tableName: string,
    updates: BulkUpdateOperation[],
    options: BulkUpdateOptions = {}
  ): Promise<BulkUpdateResult> {
    const startTime = Date.now()
    const chunkSize = Math.min(options.chunkSize || this.DEFAULT_CHUNK_SIZE, this.MAX_CHUNK_SIZE)
    const schema = options.schema || 'public'

    try {
      // Validate operation
      if (!updates || updates.length === 0) {
        throw new Error('Update operations array is required and must not be empty')
      }

      if (updates.length > this.MAX_BULK_SIZE) {
        throw new Error(`Bulk update exceeds maximum size of ${this.MAX_BULK_SIZE} operations`)
      }

      const client = getProjectDatabaseClient()
      const chunks = this.chunkArray(updates, chunkSize)
      const results: BulkUpdateChunkResult[] = []
      let totalUpdated = 0
      const failedUpdates: FailedUpdate[] = []

      // Process chunks sequentially
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex]
        
        try {
          const chunkResult = await this.updateChunk(
            context,
            client,
            tableName,
            chunk,
            schema,
            chunkIndex * chunkSize,
            options
          )

          results.push(chunkResult)
          totalUpdated += chunkResult.updatedCount
          failedUpdates.push(...chunkResult.failedUpdates)

        } catch (error) {
          // Handle chunk failure
          const chunkResult: BulkUpdateChunkResult = {
            chunkIndex,
            startIndex: chunkIndex * chunkSize,
            updatedCount: 0,
            failedUpdates: chunk.map((update, index) => ({
              update,
              error: error instanceof Error ? error.message : 'Unknown error',
              index: chunkIndex * chunkSize + index
            }))
          }

          results.push(chunkResult)
          failedUpdates.push(...chunkResult.failedUpdates)
        }
      }

      const executionTime = Date.now() - startTime

      return {
        success: failedUpdates.length === 0,
        totalOperations: updates.length,
        updatedCount: totalUpdated,
        failedCount: failedUpdates.length,
        failedUpdates,
        executionTime,
        chunks: results,
        summary: {
          totalChunks: chunks.length,
          successfulChunks: results.filter(r => r.failedUpdates.length === 0).length,
          partialChunks: results.filter(r => r.failedUpdates.length > 0 && r.updatedCount > 0).length,
          failedChunks: results.filter(r => r.updatedCount === 0).length
        }
      }

    } catch (error) {
      const executionTime = Date.now() - startTime
      console.error('Bulk update operation failed:', error)

      return {
        success: false,
        totalOperations: updates.length,
        updatedCount: 0,
        failedCount: updates.length,
        failedUpdates: updates.map((update, index) => ({
          update,
          error: error instanceof Error ? error.message : 'Unknown error',
          index
        })),
        executionTime,
        chunks: [],
        summary: {
          totalChunks: 0,
          successfulChunks: 0,
          partialChunks: 0,
          failedChunks: 1
        },
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Insert a chunk of records
   * Requirements: 8.1, 8.3, 8.4
   */
  private async insertChunk(
    context: ProjectIsolationContext,
    client: any,
    tableName: string,
    records: Record<string, any>[],
    schema: string,
    startIndex: number,
    options: BulkInsertOptions
  ): Promise<BulkChunkResult> {
    if (records.length === 0) {
      return {
        chunkIndex: Math.floor(startIndex / (options.chunkSize || this.DEFAULT_CHUNK_SIZE)),
        startIndex,
        insertedCount: 0,
        failedRecords: []
      }
    }

    try {
      // Get column names from the first record
      const columns = Object.keys(records[0])
      if (columns.length === 0) {
        throw new Error('Records must have at least one column')
      }

      // Build INSERT query with ON CONFLICT handling
      const columnList = columns.map(col => this.escapeIdentifier(col)).join(', ')
      const tableName_escaped = `${this.escapeIdentifier(schema)}.${this.escapeIdentifier(tableName)}`
      
      // Build VALUES clause with parameterized queries
      const valueRows: string[] = []
      const params: any[] = []
      let paramIndex = 1

      for (const record of records) {
        const rowValues: string[] = []
        for (const column of columns) {
          rowValues.push(`$${paramIndex}`)
          params.push(record[column] ?? null)
          paramIndex++
        }
        valueRows.push(`(${rowValues.join(', ')})`)
      }

      let query = `INSERT INTO ${tableName_escaped} (${columnList}) VALUES ${valueRows.join(', ')}`

      // Handle conflict resolution
      if (options.onConflict) {
        switch (options.onConflict) {
          case 'ignore':
            query += ' ON CONFLICT DO NOTHING'
            break
          case 'update':
            if (options.conflictColumns && options.conflictColumns.length > 0) {
              const conflictCols = options.conflictColumns.map(col => this.escapeIdentifier(col)).join(', ')
              const updateClauses = columns
                .filter(col => !options.conflictColumns!.includes(col))
                .map(col => `${this.escapeIdentifier(col)} = EXCLUDED.${this.escapeIdentifier(col)}`)
              
              if (updateClauses.length > 0) {
                query += ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateClauses.join(', ')}`
              } else {
                query += ` ON CONFLICT (${conflictCols}) DO NOTHING`
              }
            } else {
              query += ' ON CONFLICT DO NOTHING'
            }
            break
        }
      }

      // Add RETURNING clause if requested
      if (options.returning) {
        const returningCols = options.returning === '*' ? '*' : 
          options.returning.map(col => this.escapeIdentifier(col)).join(', ')
        query += ` RETURNING ${returningCols}`
      }

      // Execute the query
      const result = await client.queryProjectDatabase(context, query, params)

      return {
        chunkIndex: Math.floor(startIndex / (options.chunkSize || this.DEFAULT_CHUNK_SIZE)),
        startIndex,
        insertedCount: result.rowCount || 0,
        failedRecords: [],
        returnedData: options.returning ? result.rows : undefined
      }

    } catch (error) {
      console.error(`Insert chunk failed (starting at index ${startIndex}):`, error)

      // Try to identify which specific records failed
      const failedRecords: FailedRecord[] = []
      
      if (options.continueOnError) {
        // Try inserting records individually to identify failures
        let insertedCount = 0
        
        for (let i = 0; i < records.length; i++) {
          try {
            const record = records[i]
            const columns = Object.keys(record)
            const columnList = columns.map(col => this.escapeIdentifier(col)).join(', ')
            const tableName_escaped = `${this.escapeIdentifier(schema)}.${this.escapeIdentifier(tableName)}`
            const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ')
            const values = columns.map(col => record[col] ?? null)

            let singleQuery = `INSERT INTO ${tableName_escaped} (${columnList}) VALUES (${placeholders})`
            
            if (options.onConflict === 'ignore') {
              singleQuery += ' ON CONFLICT DO NOTHING'
            }

            const singleResult = await client.queryProjectDatabase(context, singleQuery, values)
            if (singleResult.rowCount && singleResult.rowCount > 0) {
              insertedCount++
            }
          } catch (singleError) {
            failedRecords.push({
              record: records[i],
              error: singleError instanceof Error ? singleError.message : 'Unknown error',
              index: startIndex + i
            })
          }
        }

        return {
          chunkIndex: Math.floor(startIndex / (options.chunkSize || this.DEFAULT_CHUNK_SIZE)),
          startIndex,
          insertedCount,
          failedRecords
        }
      } else {
        // Mark all records in chunk as failed
        for (let i = 0; i < records.length; i++) {
          failedRecords.push({
            record: records[i],
            error: error instanceof Error ? error.message : 'Unknown error',
            index: startIndex + i
          })
        }

        return {
          chunkIndex: Math.floor(startIndex / (options.chunkSize || this.DEFAULT_CHUNK_SIZE)),
          startIndex,
          insertedCount: 0,
          failedRecords
        }
      }
    }
  }

  /**
   * Update a chunk of records
   * Requirements: 8.2, 8.3, 8.4
   */
  private async updateChunk(
    context: ProjectIsolationContext,
    client: any,
    tableName: string,
    updates: BulkUpdateOperation[],
    schema: string,
    startIndex: number,
    options: BulkUpdateOptions
  ): Promise<BulkUpdateChunkResult> {
    if (updates.length === 0) {
      return {
        chunkIndex: Math.floor(startIndex / (options.chunkSize || this.DEFAULT_CHUNK_SIZE)),
        startIndex,
        updatedCount: 0,
        failedUpdates: []
      }
    }

    const failedUpdates: FailedUpdate[] = []
    let updatedCount = 0

    // Process updates individually since each may have different WHERE conditions
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i]
      
      try {
        const result = await this.executeSingleUpdate(context, client, tableName, update, schema, options)
        updatedCount += result.rowCount || 0
      } catch (error) {
        failedUpdates.push({
          update,
          error: error instanceof Error ? error.message : 'Unknown error',
          index: startIndex + i
        })

        // Stop processing if continueOnError is false
        if (!options.continueOnError) {
          // Mark remaining updates as failed
          for (let j = i + 1; j < updates.length; j++) {
            failedUpdates.push({
              update: updates[j],
              error: 'Skipped due to previous error',
              index: startIndex + j
            })
          }
          break
        }
      }
    }

    return {
      chunkIndex: Math.floor(startIndex / (options.chunkSize || this.DEFAULT_CHUNK_SIZE)),
      startIndex,
      updatedCount,
      failedUpdates
    }
  }

  /**
   * Execute a single update operation
   * Requirements: 8.2, 8.4
   */
  private async executeSingleUpdate(
    context: ProjectIsolationContext,
    client: any,
    tableName: string,
    update: BulkUpdateOperation,
    schema: string,
    options: BulkUpdateOptions
  ): Promise<any> {
    const tableName_escaped = `${this.escapeIdentifier(schema)}.${this.escapeIdentifier(tableName)}`
    
    // Build SET clause
    const setColumns = Object.keys(update.data)
    if (setColumns.length === 0) {
      throw new Error('Update data cannot be empty')
    }

    const setClauses: string[] = []
    const params: any[] = []
    let paramIndex = 1

    for (const column of setColumns) {
      setClauses.push(`${this.escapeIdentifier(column)} = $${paramIndex}`)
      params.push(update.data[column])
      paramIndex++
    }

    let query = `UPDATE ${tableName_escaped} SET ${setClauses.join(', ')}`

    // Build WHERE clause
    if (update.filters && update.filters.length > 0) {
      const whereConditions: string[] = []
      
      for (const filter of update.filters) {
        const condition = this.buildWhereCondition(filter, paramIndex)
        if (condition) {
          whereConditions.push(condition.clause)
          params.push(...condition.params)
          paramIndex += condition.params.length
        }
      }

      if (whereConditions.length > 0) {
        query += ` WHERE ${whereConditions.join(' AND ')}`
      }
    } else {
      throw new Error('Update operations must include WHERE conditions for safety')
    }

    // Add RETURNING clause if requested
    if (options.returning) {
      const returningCols = options.returning === '*' ? '*' : 
        options.returning.map(col => this.escapeIdentifier(col)).join(', ')
      query += ` RETURNING ${returningCols}`
    }

    return await client.queryProjectDatabase(context, query, params)
  }

  /**
   * Build WHERE condition for updates
   * Requirements: 8.2
   */
  private buildWhereCondition(filter: UpdateFilter, paramIndex: number): { clause: string; params: any[] } | null {
    const { column, operator, value } = filter
    const columnRef = this.escapeIdentifier(column)

    switch (operator) {
      case 'eq':
        return { clause: `${columnRef} = $${paramIndex}`, params: [value] }
      case 'neq':
        return { clause: `${columnRef} != $${paramIndex}`, params: [value] }
      case 'gt':
        return { clause: `${columnRef} > $${paramIndex}`, params: [value] }
      case 'gte':
        return { clause: `${columnRef} >= $${paramIndex}`, params: [value] }
      case 'lt':
        return { clause: `${columnRef} < $${paramIndex}`, params: [value] }
      case 'lte':
        return { clause: `${columnRef} <= $${paramIndex}`, params: [value] }
      case 'in':
        if (Array.isArray(value)) {
          const placeholders = value.map((_, i) => `$${paramIndex + i}`).join(', ')
          return { clause: `${columnRef} IN (${placeholders})`, params: value }
        }
        return { clause: `${columnRef} = $${paramIndex}`, params: [value] }
      case 'is':
        if (value === null) {
          return { clause: `${columnRef} IS NULL`, params: [] }
        } else if (value === true) {
          return { clause: `${columnRef} IS TRUE`, params: [] }
        } else if (value === false) {
          return { clause: `${columnRef} IS FALSE`, params: [] }
        }
        return { clause: `${columnRef} = $${paramIndex}`, params: [value] }
      default:
        console.warn(`Unsupported WHERE operator: ${operator}`)
        return null
    }
  }

  /**
   * Split array into chunks
   * Requirements: 8.3
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize))
    }
    return chunks
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
   * Get bulk operation statistics
   * Requirements: 8.5
   */
  getBulkOperationLimits(): BulkOperationLimits {
    return {
      maxBulkSize: this.MAX_BULK_SIZE,
      maxChunkSize: this.MAX_CHUNK_SIZE,
      defaultChunkSize: this.DEFAULT_CHUNK_SIZE,
      recommendedChunkSize: {
        small: 50,   // For complex records or slow connections
        medium: 100, // Default for most use cases
        large: 500   // For simple records and fast connections
      }
    }
  }
}

/**
 * Bulk operation interface
 */
export interface BulkOperation {
  type: 'insert' | 'update'
  tableName: string
  records: Record<string, any>[]
  chunkSize?: number
}

/**
 * Bulk validation result interface
 */
export interface BulkValidationResult {
  isValid: boolean
  errors: string[]
  recordErrors: RecordValidationError[]
}

/**
 * Record validation error interface
 */
export interface RecordValidationError {
  index: number
  error: string
}

/**
 * Bulk insert options interface
 */
export interface BulkInsertOptions {
  chunkSize?: number
  schema?: string
  onConflict?: 'ignore' | 'update'
  conflictColumns?: string[]
  returning?: string[] | '*'
  continueOnError?: boolean
}

/**
 * Bulk update options interface
 */
export interface BulkUpdateOptions {
  chunkSize?: number
  schema?: string
  returning?: string[] | '*'
  continueOnError?: boolean
}

/**
 * Bulk update operation interface
 */
export interface BulkUpdateOperation {
  data: Record<string, any>
  filters: UpdateFilter[]
}

/**
 * Update filter interface
 */
export interface UpdateFilter {
  column: string
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is'
  value: any
}

/**
 * Failed record interface
 */
export interface FailedRecord {
  record: Record<string, any>
  error: string
  index: number
}

/**
 * Failed update interface
 */
export interface FailedUpdate {
  update: BulkUpdateOperation
  error: string
  index: number
}

/**
 * Bulk chunk result interface
 */
export interface BulkChunkResult {
  chunkIndex: number
  startIndex: number
  insertedCount: number
  failedRecords: FailedRecord[]
  returnedData?: any[]
}

/**
 * Bulk update chunk result interface
 */
export interface BulkUpdateChunkResult {
  chunkIndex: number
  startIndex: number
  updatedCount: number
  failedUpdates: FailedUpdate[]
}

/**
 * Bulk insert result interface
 */
export interface BulkInsertResult {
  success: boolean
  totalRecords: number
  insertedCount: number
  failedCount: number
  failedRecords: FailedRecord[]
  executionTime: number
  chunks: BulkChunkResult[]
  summary: {
    totalChunks: number
    successfulChunks: number
    partialChunks: number
    failedChunks: number
  }
  error?: string
}

/**
 * Bulk update result interface
 */
export interface BulkUpdateResult {
  success: boolean
  totalOperations: number
  updatedCount: number
  failedCount: number
  failedUpdates: FailedUpdate[]
  executionTime: number
  chunks: BulkUpdateChunkResult[]
  summary: {
    totalChunks: number
    successfulChunks: number
    partialChunks: number
    failedChunks: number
  }
  error?: string
}

/**
 * Bulk operation limits interface
 */
export interface BulkOperationLimits {
  maxBulkSize: number
  maxChunkSize: number
  defaultChunkSize: number
  recommendedChunkSize: {
    small: number
    medium: number
    large: number
  }
}

/**
 * Factory function to get the bulk operation service
 */
export function getBulkOperationService(): BulkOperationService {
  return BulkOperationService.getInstance()
}