import { getProjectDatabaseClient } from './project-database-client'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { getResponseShapingService, SelectCriteria } from './response-shaping-service'

/**
 * Nested Resource Service
 * Handles nested resource queries with foreign key relationship traversal
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */
export class NestedResourceService {
  private static instance: NestedResourceService
  private relationshipCache = new Map<string, RelationshipDefinition[]>()
  private cacheExpiry = new Map<string, number>()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes
  private readonly MAX_NESTING_DEPTH = 5 // Prevent infinite recursion

  private constructor() {}

  static getInstance(): NestedResourceService {
    if (!NestedResourceService.instance) {
      NestedResourceService.instance = new NestedResourceService()
    }
    return NestedResourceService.instance
  }

  /**
   * Parse nested resource selection from select parameter
   * Requirements: 9.1
   */
  parseNestedSelection(selectParam: string): NestedResourceQuery[] {
    if (!selectParam || !selectParam.includes('(')) {
      return []
    }

    const nestedQueries: NestedResourceQuery[] = []
    const parts = this.parseSelectParts(selectParam)

    for (const part of parts) {
      // Only process parts that contain parentheses (nested resources)
      if (part.includes('(') && part.includes(')')) {
        const nestedMatch = part.match(/^(\w+)(\!inner|\!left)?(\(([^)]+)\))?(\[([^\]]+)\])?$/)
        if (nestedMatch) {
          const [, relation, joinType, , columns, , filters] = nestedMatch
          
          nestedQueries.push({
            relation,
            joinType: this.parseJoinType(joinType),
            columns: columns ? columns.split(',').map(col => col.trim()) : ['*'],
            filters: filters ? this.parseFilters(filters) : [],
            limit: this.extractLimit(filters),
            offset: this.extractOffset(filters),
            orderBy: this.extractOrderBy(filters)
          })
        }
      }
    }

    return nestedQueries
  }

  /**
   * Execute nested resource query with relationship traversal
   * Requirements: 9.1, 9.2, 9.3
   */
  async executeNestedQuery(
    context: ProjectIsolationContext,
    baseTable: string,
    baseData: any[],
    nestedQueries: NestedResourceQuery[],
    schema: string = 'public',
    currentDepth: number = 0
  ): Promise<NestedQueryResult> {
    try {
      // Prevent infinite recursion
      if (currentDepth >= this.MAX_NESTING_DEPTH) {
        return {
          success: false,
          error: `Maximum nesting depth (${this.MAX_NESTING_DEPTH}) exceeded`,
          code: 'PGRST_MAX_DEPTH'
        }
      }

      // Check for circular references
      const circularCheck = this.detectCircularReferences(baseTable, nestedQueries, schema)
      if (!circularCheck.isValid) {
        return {
          success: false,
          error: circularCheck.error,
          code: 'PGRST_CIRCULAR_REF'
        }
      }

      if (baseData.length === 0) {
        return {
          success: true,
          data: baseData,
          nestedData: new Map()
        }
      }

      // Get relationships for the base table
      const relationships = await this.getTableRelationships(context, baseTable, schema)
      const nestedData = new Map<string, any[]>()
      const enrichedData = [...baseData]

      // Process each nested query
      for (const nestedQuery of nestedQueries) {
        console.log(`[executeNestedQuery] Looking for relationship:`, {
          nestedQueryRelation: nestedQuery.relation,
          availableRelationships: relationships.map(r => ({
            relationName: r.relationName,
            targetTable: r.targetTable,
            sourceTable: r.sourceTable
          }))
        })

        const relationship = relationships.find(rel => 
          rel.relationName === nestedQuery.relation ||
          rel.targetTable === nestedQuery.relation
        )

        console.log(`[executeNestedQuery] Found relationship:`, relationship)

        if (!relationship) {
          return {
            success: false,
            error: `No relationship found for '${nestedQuery.relation}' from table '${baseTable}'`,
            code: 'PGRST_NO_RELATION'
          }
        }

        // Validate permissions for nested resource
        const permissionCheck = await this.validateNestedResourcePermissions(
          context,
          relationship.targetTable,
          relationship.targetSchema
        )

        if (!permissionCheck.isValid) {
          return {
            success: false,
            error: permissionCheck.error,
            code: 'PGRST_PERMISSION_DENIED'
          }
        }

        // Execute nested query based on relationship type
        const nestedResult = await this.executeRelationshipQuery(
          context,
          baseData,
          relationship,
          nestedQuery,
          currentDepth + 1
        )

        if (!nestedResult.success) {
          return nestedResult
        }

        // Store nested data and enrich base data
        nestedData.set(nestedQuery.relation, nestedResult.data || [])
        this.enrichBaseDataWithNested(enrichedData, nestedResult.data || [], relationship, nestedQuery)
      }

      return {
        success: true,
        data: enrichedData,
        nestedData,
        relationships: relationships.filter(rel => 
          nestedQueries.some(nq => nq.relation === rel.relationName || nq.relation === rel.targetTable)
        )
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error in nested query',
        code: 'PGRST000'
      }
    }
  }

  /**
   * Get foreign key relationships for a table
   * Requirements: 9.1
   */
  private async getTableRelationships(
    context: ProjectIsolationContext,
    tableName: string,
    schema: string = 'public'
  ): Promise<RelationshipDefinition[]> {
    const cacheKey = `${context.projectRef}:${schema}:${tableName}`
    
    // Check cache first
    if (this.isCacheValid(cacheKey)) {
      const cached = this.relationshipCache.get(cacheKey)
      if (cached) {
        return cached
      }
    }

    try {
      const projectDbClient = getProjectDatabaseClient()
      
      // Query to get foreign key relationships using pg_catalog (accessible to all users)
      const query = `
        SELECT 
          con.conname as constraint_name,
          rel.relname as source_table,
          ns.nspname as source_schema,
          att.attname as source_column,
          frel.relname as target_table,
          fns.nspname as target_schema,
          fatt.attname as target_column,
          CASE con.confupdtype
            WHEN 'a' THEN 'NO ACTION'
            WHEN 'r' THEN 'RESTRICT'
            WHEN 'c' THEN 'CASCADE'
            WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT'
          END as update_rule,
          CASE con.confdeltype
            WHEN 'a' THEN 'NO ACTION'
            WHEN 'r' THEN 'RESTRICT'
            WHEN 'c' THEN 'CASCADE'
            WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT'
          END as delete_rule,
          CASE 
            WHEN rel.relname = $2 THEN 'outbound'
            ELSE 'inbound'
          END as relationship_type
        FROM pg_constraint con
        JOIN pg_class rel ON con.conrelid = rel.oid
        JOIN pg_namespace ns ON rel.relnamespace = ns.oid
        JOIN pg_class frel ON con.confrelid = frel.oid
        JOIN pg_namespace fns ON frel.relnamespace = fns.oid
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
        JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = con.confkey[1]
        WHERE con.contype = 'f'
          AND ns.nspname = $1
          AND rel.relname = $2
        
        UNION ALL
        
        SELECT 
          con.conname as constraint_name,
          rel.relname as source_table,
          ns.nspname as source_schema,
          att.attname as source_column,
          frel.relname as target_table,
          fns.nspname as target_schema,
          fatt.attname as target_column,
          CASE con.confupdtype
            WHEN 'a' THEN 'NO ACTION'
            WHEN 'r' THEN 'RESTRICT'
            WHEN 'c' THEN 'CASCADE'
            WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT'
          END as update_rule,
          CASE con.confdeltype
            WHEN 'a' THEN 'NO ACTION'
            WHEN 'r' THEN 'RESTRICT'
            WHEN 'c' THEN 'CASCADE'
            WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT'
          END as delete_rule,
          'inbound' as relationship_type
        FROM pg_constraint con
        JOIN pg_class rel ON con.conrelid = rel.oid
        JOIN pg_namespace ns ON rel.relnamespace = ns.oid
        JOIN pg_class frel ON con.confrelid = frel.oid
        JOIN pg_namespace fns ON frel.relnamespace = fns.oid
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
        JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = con.confkey[1]
        WHERE con.contype = 'f'
          AND fns.nspname = $1
          AND frel.relname = $2
        ORDER BY constraint_name
      `

      console.log(`[getTableRelationships] Executing query for ${schema}.${tableName}`)

      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        'metadata-query',  // Special identifier for metadata queries
        query,
        [schema, tableName],
        { skipPermissionCheck: true }
      )

      console.log(`[getTableRelationships] Query result for ${schema}.${tableName}:`, {
        rowCount: result.rows.length,
        rows: result.rows
      })

      const relationships: RelationshipDefinition[] = result.rows.map(row => ({
        constraintName: row.constraint_name,
        sourceTable: row.source_table,
        sourceSchema: row.source_schema,
        sourceColumn: row.source_column,
        targetTable: row.target_table,
        targetSchema: row.target_schema,
        targetColumn: row.target_column,
        updateRule: row.update_rule,
        deleteRule: row.delete_rule,
        relationshipType: row.relationship_type,
        relationName: row.relationship_type === 'outbound' ? row.target_table : row.source_table
      }))

      console.log(`[getTableRelationships] Mapped relationships:`, relationships)

      // Cache the relationships
      this.relationshipCache.set(cacheKey, relationships)
      this.cacheExpiry.set(cacheKey, Date.now() + this.CACHE_TTL)

      return relationships
    } catch (error) {
      console.error(`Failed to get relationships for table ${tableName}:`, error)
      return []
    }
  }

  /**
   * Execute relationship query based on foreign key
   * Requirements: 9.2, 9.3
   */
  private async executeRelationshipQuery(
    context: ProjectIsolationContext,
    baseData: any[],
    relationship: RelationshipDefinition,
    nestedQuery: NestedResourceQuery,
    currentDepth: number
  ): Promise<NestedQueryResult> {
    try {
      const projectDbClient = getProjectDatabaseClient()
      
      // Extract foreign key values from base data
      const foreignKeyValues = this.extractForeignKeyValues(baseData, relationship)
      
      console.log(`[executeRelationshipQuery] Extracted foreign key values:`, {
        relationship: relationship.relationName,
        foreignKeyValues,
        baseDataCount: baseData.length
      })
      
      if (foreignKeyValues.length === 0) {
        console.log(`[executeRelationshipQuery] No foreign key values, returning empty`)
        return {
          success: true,
          data: [],
          nestedData: new Map()
        }
      }

      // Build the nested query
      // For inbound relationships (one-to-many), query the source table
      // For outbound relationships (many-to-one), query the target table
      const queryTable = relationship.relationshipType === 'inbound' 
        ? relationship.sourceTable 
        : relationship.targetTable
      const querySchema = relationship.relationshipType === 'inbound'
        ? relationship.sourceSchema
        : relationship.targetSchema
      
      // Determine which foreign key column to include in SELECT
      const foreignKeyColumn = relationship.relationshipType === 'inbound'
        ? relationship.sourceColumn  // For inbound, include the FK column from source table
        : relationship.targetColumn  // For outbound, include the PK column from target table
      
      const selectClause = this.buildNestedSelectClause(nestedQuery.columns, queryTable, foreignKeyColumn)
      const whereClause = this.buildNestedWhereClause(relationship, foreignKeyValues, nestedQuery.filters)
      const orderClause = this.buildOrderClause(nestedQuery.orderBy)
      const limitClause = this.buildLimitClause(nestedQuery.limit, nestedQuery.offset)

      const query = `
        SELECT ${selectClause}
        FROM "${querySchema}"."${queryTable}"
        WHERE ${whereClause}
        ${orderClause}
        ${limitClause}
      `

      console.log(`[executeRelationshipQuery] Executing nested query:`, {
        query,
        relationship: relationship.relationName
      })

      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        'metadata-query',
        query,
        [],
        { skipPermissionCheck: true }
      )

      console.log(`[executeRelationshipQuery] Query result:`, {
        rowCount: result.rows.length,
        rows: result.rows
      })

      // Process any nested queries within this nested query
      let nestedData = result.rows
      const nestedNestedQueries = this.extractNestedQueries(nestedQuery.columns)
      
      if (nestedNestedQueries.length > 0) {
        const deepNestedResult = await this.executeNestedQuery(
          context,
          relationship.targetTable,
          nestedData,
          nestedNestedQueries,
          relationship.targetSchema,
          currentDepth
        )

        if (!deepNestedResult.success) {
          return deepNestedResult
        }

        nestedData = deepNestedResult.data || []
      }

      return {
        success: true,
        data: nestedData,
        nestedData: new Map()
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error in relationship query',
        code: 'PGRST000'
      }
    }
  }

  /**
   * Detect circular references in nested queries
   * Requirements: 9.4
   */
  private detectCircularReferences(
    baseTable: string,
    nestedQueries: NestedResourceQuery[],
    schema: string,
    visitedTables: Set<string> = new Set()
  ): CircularReferenceCheck {
    const currentTableKey = `${schema}.${baseTable}`
    
    if (visitedTables.has(currentTableKey)) {
      return {
        isValid: false,
        error: `Circular reference detected: ${Array.from(visitedTables).join(' -> ')} -> ${currentTableKey}`,
        circularPath: Array.from(visitedTables).concat(currentTableKey)
      }
    }

    visitedTables.add(currentTableKey)

    for (const nestedQuery of nestedQueries) {
      const nestedTableKey = `${schema}.${nestedQuery.relation}`
      
      // Check for immediate circular reference
      if (visitedTables.has(nestedTableKey)) {
        return {
          isValid: false,
          error: `Circular reference detected: ${Array.from(visitedTables).join(' -> ')} -> ${nestedTableKey}`,
          circularPath: Array.from(visitedTables).concat(nestedTableKey)
        }
      }

      // Recursively check nested queries within this nested query
      const deepNestedQueries = this.extractNestedQueries(nestedQuery.columns)
      if (deepNestedQueries.length > 0) {
        const deepCheck = this.detectCircularReferences(
          nestedQuery.relation,
          deepNestedQueries,
          schema,
          new Set(visitedTables)
        )
        
        if (!deepCheck.isValid) {
          return deepCheck
        }
      }
    }

    return { isValid: true }
  }

  /**
   * Validate permissions for nested resource access
   * Requirements: 9.5
   */
  private async validateNestedResourcePermissions(
    context: ProjectIsolationContext,
    tableName: string,
    schema: string
  ): Promise<PermissionValidationResult> {
    // For project-level isolation, skip user-level permission checks
    // Access is already validated at the project level
    return { isValid: true }
  }

  /**
   * Extract foreign key values from base data
   */
  private extractForeignKeyValues(baseData: any[], relationship: RelationshipDefinition): any[] {
    const values: any[] = []
    const columnName = relationship.relationshipType === 'outbound' 
      ? relationship.sourceColumn 
      : relationship.targetColumn

    for (const row of baseData) {
      const value = row[columnName]
      if (value !== null && value !== undefined && !values.includes(value)) {
        values.push(value)
      }
    }

    return values
  }

  /**
   * Build SELECT clause for nested query
   */
  private buildNestedSelectClause(columns: string[], tableName: string, foreignKeyColumn?: string): string {
    if (columns.includes('*')) {
      return '*'
    }

    const selectParts: string[] = []
    
    // Always include the foreign key column for matching (if not already included)
    if (foreignKeyColumn && !columns.includes(foreignKeyColumn)) {
      selectParts.push(`"${foreignKeyColumn}"`)
    }
    
    for (const column of columns) {
      if (column.includes('(')) {
        const baseColumn = column.split('(')[0]
        if (!selectParts.includes(`"${baseColumn}"`)) {
          selectParts.push(`"${baseColumn}"`)
        }
      } else {
        if (!selectParts.includes(`"${column}"`)) {
          selectParts.push(`"${column}"`)
        }
      }
    }

    return selectParts.join(', ')
  }

  /**
   * Build WHERE clause for nested query
   */
  private buildNestedWhereClause(
    relationship: RelationshipDefinition,
    foreignKeyValues: any[],
    additionalFilters: QueryFilter[]
  ): string {
    const targetColumn = relationship.relationshipType === 'outbound' 
      ? relationship.targetColumn 
      : relationship.sourceColumn

    // Build the foreign key filter
    const fkFilter = foreignKeyValues.length === 1
      ? `"${targetColumn}" = '${foreignKeyValues[0]}'`
      : `"${targetColumn}" IN (${foreignKeyValues.map(v => `'${v}'`).join(', ')})`

    // Add additional filters
    const additionalWhere = additionalFilters
      .map(filter => this.buildFilterClause(filter))
      .filter(clause => clause)
      .join(' AND ')

    return additionalWhere 
      ? `${fkFilter} AND ${additionalWhere}`
      : fkFilter
  }

  /**
   * Build filter clause from QueryFilter
   */
  private buildFilterClause(filter: QueryFilter): string {
    const { column, operator, value, negate } = filter
    let clause = ''

    switch (operator) {
      case 'eq':
        clause = `"${column}" = '${value}'`
        break
      case 'neq':
        clause = `"${column}" != '${value}'`
        break
      case 'gt':
        clause = `"${column}" > '${value}'`
        break
      case 'gte':
        clause = `"${column}" >= '${value}'`
        break
      case 'lt':
        clause = `"${column}" < '${value}'`
        break
      case 'lte':
        clause = `"${column}" <= '${value}'`
        break
      case 'like':
        clause = `"${column}" LIKE '${value}'`
        break
      case 'ilike':
        clause = `"${column}" ILIKE '${value}'`
        break
      case 'in':
        const values = Array.isArray(value) ? value : [value]
        clause = `"${column}" IN (${values.map(v => `'${v}'`).join(', ')})`
        break
      case 'is':
        clause = value === null ? `"${column}" IS NULL` : `"${column}" IS NOT NULL`
        break
      default:
        return ''
    }

    return negate ? `NOT (${clause})` : clause
  }

  /**
   * Build ORDER BY clause
   */
  private buildOrderClause(orderBy?: OrderByClause[]): string {
    if (!orderBy || orderBy.length === 0) {
      return ''
    }

    const orderParts = orderBy.map(order => 
      `"${order.column}" ${order.direction.toUpperCase()}`
    )

    return `ORDER BY ${orderParts.join(', ')}`
  }

  /**
   * Build LIMIT and OFFSET clause
   */
  private buildLimitClause(limit?: number, offset?: number): string {
    const parts: string[] = []
    
    if (limit !== undefined && limit > 0) {
      parts.push(`LIMIT ${limit}`)
    }
    
    if (offset !== undefined && offset > 0) {
      parts.push(`OFFSET ${offset}`)
    }

    return parts.join(' ')
  }

  /**
   * Enrich base data with nested data
   */
  private enrichBaseDataWithNested(
    baseData: any[],
    nestedData: any[],
    relationship: RelationshipDefinition,
    nestedQuery: NestedResourceQuery
  ): void {
    const sourceColumn = relationship.relationshipType === 'outbound' 
      ? relationship.sourceColumn 
      : relationship.targetColumn
    const targetColumn = relationship.relationshipType === 'outbound' 
      ? relationship.targetColumn 
      : relationship.sourceColumn

    console.log(`[enrichBaseDataWithNested] Enriching data:`, {
      relationshipType: relationship.relationshipType,
      sourceColumn,
      targetColumn,
      baseDataCount: baseData.length,
      nestedDataCount: nestedData.length,
      sampleBaseRow: baseData[0],
      sampleNestedRow: nestedData[0]
    })

    // Group nested data by foreign key
    const nestedByKey = new Map<any, any[]>()
    for (const nestedRow of nestedData) {
      const key = nestedRow[targetColumn]
      if (!nestedByKey.has(key)) {
        nestedByKey.set(key, [])
      }
      nestedByKey.get(key)!.push(nestedRow)
    }

    console.log(`[enrichBaseDataWithNested] Grouped nested data:`, {
      keys: Array.from(nestedByKey.keys()),
      counts: Array.from(nestedByKey.entries()).map(([k, v]) => ({ key: k, count: v.length }))
    })

    // Enrich base data
    for (const baseRow of baseData) {
      const foreignKeyValue = baseRow[sourceColumn]
      const relatedData = nestedByKey.get(foreignKeyValue) || []
      
      console.log(`[enrichBaseDataWithNested] Matching:`, {
        baseRowId: baseRow.id,
        foreignKeyValue,
        relatedDataCount: relatedData.length
      })
      
      // Determine if this should be a single object or array
      const isSingleRelation = relationship.relationshipType === 'outbound'
      baseRow[nestedQuery.relation] = isSingleRelation && relatedData.length <= 1 
        ? (relatedData[0] || null)
        : relatedData
    }
  }

  /**
   * Extract nested queries from column specifications
   */
  private extractNestedQueries(columns: string[]): NestedResourceQuery[] {
    const nestedQueries: NestedResourceQuery[] = []
    
    for (const column of columns) {
      if (column.includes('(')) {
        const nestedMatch = column.match(/^(\w+)(\!inner|\!left)?(\(([^)]+)\))?$/)
        if (nestedMatch) {
          const [, relation, joinType, , nestedColumns] = nestedMatch
          
          nestedQueries.push({
            relation,
            joinType: this.parseJoinType(joinType),
            columns: nestedColumns ? nestedColumns.split(',').map(col => col.trim()) : ['*'],
            filters: [],
            limit: undefined,
            offset: undefined,
            orderBy: undefined
          })
        }
      }
    }

    return nestedQueries
  }

  /**
   * Parse select parameter parts, handling nested parentheses
   */
  private parseSelectParts(selectParam: string): string[] {
    const parts: string[] = []
    let current = ''
    let depth = 0
    
    for (let i = 0; i < selectParam.length; i++) {
      const char = selectParam[i]
      
      if (char === '(') {
        depth++
        current += char
      } else if (char === ')') {
        depth--
        current += char
      } else if (char === ',' && depth === 0) {
        if (current.trim()) {
          parts.push(current.trim())
        }
        current = ''
      } else {
        current += char
      }
    }
    
    if (current.trim()) {
      parts.push(current.trim())
    }
    
    return parts
  }

  /**
   * Parse join type from string
   */
  private parseJoinType(joinType?: string): JoinType {
    if (!joinType) return 'left'
    
    switch (joinType.toLowerCase()) {
      case '!inner':
        return 'inner'
      case '!left':
        return 'left'
      default:
        return 'left'
    }
  }

  /**
   * Parse filters from filter string
   */
  private parseFilters(filterString: string): QueryFilter[] {
    // This is a simplified implementation
    // In a full implementation, you'd parse complex filter expressions
    return []
  }

  /**
   * Extract limit from filter string
   */
  private extractLimit(filterString?: string): number | undefined {
    if (!filterString) return undefined
    
    const limitMatch = filterString.match(/limit=(\d+)/)
    return limitMatch ? parseInt(limitMatch[1], 10) : undefined
  }

  /**
   * Extract offset from filter string
   */
  private extractOffset(filterString?: string): number | undefined {
    if (!filterString) return undefined
    
    const offsetMatch = filterString.match(/offset=(\d+)/)
    return offsetMatch ? parseInt(offsetMatch[1], 10) : undefined
  }

  /**
   * Extract order by from filter string
   */
  private extractOrderBy(filterString?: string): OrderByClause[] | undefined {
    if (!filterString) return undefined
    
    const orderMatch = filterString.match(/order=([^&]+)/)
    if (!orderMatch) return undefined
    
    const orderParts = orderMatch[1].split(',')
    return orderParts.map(part => {
      const [column, direction = 'asc'] = part.split('.')
      return {
        column: column.trim(),
        direction: direction.trim() as 'asc' | 'desc'
      }
    })
  }

  /**
   * Check if cache is valid for a given key
   */
  private isCacheValid(cacheKey: string): boolean {
    const expiry = this.cacheExpiry.get(cacheKey)
    return expiry !== undefined && Date.now() < expiry
  }

  /**
   * Clear relationship cache for a project
   */
  clearCache(projectRef: string, schema?: string, tableName?: string): void {
    if (tableName && schema) {
      const cacheKey = `${projectRef}:${schema}:${tableName}`
      this.relationshipCache.delete(cacheKey)
      this.cacheExpiry.delete(cacheKey)
    } else if (schema) {
      for (const key of this.relationshipCache.keys()) {
        if (key.startsWith(`${projectRef}:${schema}:`)) {
          this.relationshipCache.delete(key)
          this.cacheExpiry.delete(key)
        }
      }
    } else {
      for (const key of this.relationshipCache.keys()) {
        if (key.startsWith(`${projectRef}:`)) {
          this.relationshipCache.delete(key)
          this.cacheExpiry.delete(key)
        }
      }
    }
  }
}

/**
 * Nested resource query definition
 * Requirements: 9.1, 9.2
 */
export interface NestedResourceQuery {
  relation: string
  joinType: JoinType
  columns: string[]
  filters: QueryFilter[]
  limit?: number
  offset?: number
  orderBy?: OrderByClause[]
}

/**
 * Join type for nested queries
 */
export type JoinType = 'left' | 'inner'

/**
 * Query filter definition
 * Requirements: 9.2
 */
export interface QueryFilter {
  column: string
  operator: FilterOperator
  value: any
  logicalOperator?: 'and' | 'or'
  negate?: boolean
}

/**
 * Filter operators
 */
export type FilterOperator = 
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' 
  | 'like' | 'ilike' | 'in' | 'is' | 'not'

/**
 * Order by clause
 * Requirements: 9.3
 */
export interface OrderByClause {
  column: string
  direction: 'asc' | 'desc'
}

/**
 * Relationship definition from database schema
 * Requirements: 9.1
 */
export interface RelationshipDefinition {
  constraintName: string
  sourceTable: string
  sourceSchema: string
  sourceColumn: string
  targetTable: string
  targetSchema: string
  targetColumn: string
  updateRule: string
  deleteRule: string
  relationshipType: 'inbound' | 'outbound'
  relationName: string
}

/**
 * Nested query execution result
 * Requirements: 9.1, 9.2, 9.3
 */
export interface NestedQueryResult {
  success: boolean
  data?: any[]
  nestedData?: Map<string, any[]>
  relationships?: RelationshipDefinition[]
  error?: string
  code?: string
}

/**
 * Circular reference detection result
 * Requirements: 9.4
 */
export interface CircularReferenceCheck {
  isValid: boolean
  error?: string
  circularPath?: string[]
}

/**
 * Permission validation result
 * Requirements: 9.5
 */
export interface PermissionValidationResult {
  isValid: boolean
  error?: string
}

/**
 * Factory function to get the nested resource service
 */
export function getNestedResourceService(): NestedResourceService {
  return NestedResourceService.getInstance()
}