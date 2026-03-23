import { NextApiRequest, NextApiResponse } from 'next'
import { ProjectPostgRESTEngine } from './project-postgrest-engine'
import { ProjectIsolationContext } from './secure-api-wrapper'
import { DataApiConfigResponse } from './data-api-config-data-access'
import { getEnhancedPostgRESTConfigManager, EnhancedPostgRESTProjectConfig } from './enhanced-postgrest-config-manager'
import { getSupabaseRestContainerClient } from './supabase-rest-container-client'
import { getRPCFunctionService, FunctionResult } from './rpc-function-service'
import { getDatabaseViewService, ViewQueryParams, ViewFilter, ViewOrder } from './database-view-service'
import { getJSONQueryService, JSONFilter } from './json-query-service'
import { getFullTextSearchService, FullTextSearchFilter } from './full-text-search-service'
import { getAggregateQueryService, AggregateOperation, WhereFilter, HavingFilter } from './aggregate-query-service'
import { getResponseShapingService, SelectCriteria, ResponseFormat } from './response-shaping-service'
import { getAdvancedFilteringService, AdvancedFilter, LogicalOperatorGroup } from './advanced-filtering-service'
import { getBulkOperationService, BulkOperation, BulkInsertOptions, BulkUpdateOptions, BulkUpdateOperation } from './bulk-operation-service'
import { getNestedResourceService, NestedResourceQuery, NestedQueryResult } from './nested-resource-service'
import { getTransactionService, TransactionContext, DatabaseOperation } from './transaction-service'
import { getArrayOperationService, ArrayFilter } from './array-operation-service'
import { getContentNegotiationService, ContentNegotiationResult, ResponseFormat as CNResponseFormat } from './content-negotiation-service'
import { getProjectDatabaseClient } from './project-database-client'
import { SchemaIntrospectionService } from './schema-introspection-service'

/**
 * Enhanced Project PostgREST Engine
 * Extends the base PostgREST engine with advanced features for the enhanced supabase-rest container
 * Requirements: 1.1, 2.1, 13.1
 */
export class EnhancedProjectPostgRESTEngine extends ProjectPostgRESTEngine {
  private enhancedConfig: EnhancedPostgRESTProjectConfig | null = null
  private containerClient = getSupabaseRestContainerClient()
  private rpcService = getRPCFunctionService()
  private viewService = getDatabaseViewService()
  private jsonQueryService = getJSONQueryService()
  private fullTextSearchService = getFullTextSearchService()
  private aggregateQueryService = getAggregateQueryService()
  private responseShapingService = getResponseShapingService()
  private advancedFilteringService = getAdvancedFilteringService()
  private bulkOperationService = getBulkOperationService()
  private nestedResourceService = getNestedResourceService()
  private transactionService = getTransactionService()
  private arrayOperationService = getArrayOperationService()
  private contentNegotiationService = getContentNegotiationService()
  private schemaIntrospectionService: SchemaIntrospectionService
  private projectContext: ProjectIsolationContext

  constructor(
    context: ProjectIsolationContext,
    config: DataApiConfigResponse
  ) {
    super(context, config)
    this.projectContext = context
    this.schemaIntrospectionService = new SchemaIntrospectionService(
      this.viewService,
      this.rpcService
    )
  }

  /**
   * Initialize enhanced configuration
   * Requirements: 1.1, 2.1
   */
  private async initializeEnhancedConfig(context: ProjectIsolationContext, config: DataApiConfigResponse): Promise<void> {
    if (!this.enhancedConfig) {
      const configManager = getEnhancedPostgRESTConfigManager()
      this.enhancedConfig = await configManager.getEnhancedProjectConfig(context, config)
      
      // Update container configuration
      await this.containerClient.updateContainerConfiguration(
        context.projectRef,
        this.enhancedConfig
      )
    }
  }

  /**
   * Enhanced request handler that supports advanced PostgREST features
   * Requirements: 1.1, 2.1
   */
  async handleEnhancedRequest(
    req: NextApiRequest,
    res: NextApiResponse,
    context: ProjectIsolationContext,
    config: DataApiConfigResponse,
    resourcePath: string
  ): Promise<void> {
    try {
      // Initialize enhanced configuration
      await this.initializeEnhancedConfig(context, config)
      
      if (!this.enhancedConfig) {
        throw new Error('Failed to initialize enhanced configuration')
      }

      // Check if this is an RPC function call
      if (resourcePath.startsWith('rpc/')) {
        await this.handleRPCCall(req, res, resourcePath.substring(4))
        return
      }

      // Check if this is a function discovery request
      if (resourcePath === 'functions' && req.method === 'GET') {
        await this.handleFunctionDiscovery(req, res)
        return
      }

      // Check if this is a view access
      if (await this.isViewAccess(resourcePath)) {
        await this.handleViewQuery(req, res, resourcePath)
        return
      }

      // Check if this is a schema introspection request
      if (resourcePath === '' && req.method === 'OPTIONS') {
        await this.schemaIntrospectionService.handleIntrospectionRequest(req, res, this.projectContext)
        return
      }

      // Check if this is a dedicated schema introspection endpoint
      if (resourcePath === 'schema' && req.method === 'GET') {
        await this.schemaIntrospectionService.handleIntrospectionRequest(req, res, this.projectContext)
        return
      }

      // Check if this request contains JSON operations
      if (this.hasJSONOperations(req)) {
        await this.handleJSONQuery(req, res, resourcePath)
        return
      }

      // Check if this request contains full-text search operations
      if (this.hasFullTextSearchOperations(req)) {
        await this.handleFullTextSearchQuery(req, res, resourcePath)
        return
      }

      // Check if this request contains aggregate operations
      if (this.hasAggregateOperations(req)) {
        await this.handleAggregateQuery(req, res, resourcePath)
        return
      }

      // Check if this request contains advanced filtering operations
      // Skip for PATCH/DELETE as they use query params for WHERE conditions
      if (req.method === 'GET' && this.hasAdvancedFilteringOperations(req)) {
        await this.handleAdvancedFilteringQuery(req, res, resourcePath)
        return
      }

      // Check if this request contains array operations
      if (this.hasArrayOperations(req)) {
        await this.handleArrayOperationsQuery(req, res, resourcePath)
        return
      }

      // Check if this is a bulk operation
      if (this.isBulkOperation(req)) {
        await this.handleBulkOperation(req, res, resourcePath)
        return
      }

      // Check if this request contains nested resource queries
      if (this.hasNestedResourceQueries(req)) {
        await this.handleNestedResourceQuery(req, res, resourcePath)
        return
      }

      // Check if this request requires transaction support
      if (this.hasTransactionHeaders(req)) {
        await this.handleTransactionalRequest(req, res, resourcePath)
        return
      }

      // Check if this request requires response shaping
      if (this.requiresResponseShaping(req)) {
        await this.handleResponseShaping(req, res, resourcePath)
        return
      }

      // For enhanced features, proxy to the container
      if (this.requiresEnhancedFeatures(req)) {
        await this.containerClient.proxyRequest(req, res, context.projectRef, `/${resourcePath}`)
        return
      }

      // Fall back to base PostgREST engine for simple operations
      await this.handleRequest(req, res, resourcePath)
    } catch (error) {
      console.error('Enhanced PostgREST engine error:', error)
      
      if (error instanceof Error) {
        if (error.message.includes('function') && error.message.includes('does not exist')) {
          return res.status(404).json({
            code: 'PGRST202',
            message: 'Could not find the function in the schema cache',
            details: error.message,
            hint: 'Verify that the function exists and is accessible'
          })
        }
        
        if (error.message.includes('view') && error.message.includes('does not exist')) {
          return res.status(404).json({
            code: 'PGRST116',
            message: 'Could not find the view in the schema cache',
            details: error.message,
            hint: 'Verify that the view exists and is accessible'
          })
        }
      }
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Handle RPC function calls
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
   */
  private async handleRPCCall(req: NextApiRequest, res: NextApiResponse, functionName: string): Promise<void> {
    if (req.method !== 'POST') {
      return res.status(405).json({
        code: 'PGRST105',
        message: 'Method not allowed',
        details: 'RPC functions can only be called with POST method',
        hint: 'Use POST method for RPC function calls'
      })
    }

    if (!this.enhancedConfig?.enableRPCFunctions) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'RPC functions not enabled',
        details: 'RPC function support is disabled for this project',
        hint: 'Enable RPC functions in project configuration'
      })
    }

    try {
      // Extract parameters from request body
      const parameters = this.extractRPCParameters(req.body)
      
      // Get the schema from query parameters or use default
      const schema = (req.query.schema as string) || 'public'
      
      // Execute the function
      const result = await this.rpcService.executeFunctionCall(
        this.projectContext,
        functionName,
        parameters,
        schema
      )

      if (!result.success) {
        // Handle function execution errors
        if (result.error?.includes('does not exist')) {
          return res.status(404).json({
            code: 'PGRST202',
            message: 'Could not find the function in the schema cache',
            details: result.error,
            hint: 'Verify that the function exists and is accessible'
          })
        }

        if (result.error?.includes('permission denied')) {
          return res.status(403).json({
            code: 'PGRST301',
            message: 'Permission denied',
            details: result.error,
            hint: 'Check that the database user has EXECUTE permission on the function'
          })
        }

        if (result.error?.includes('parameter') || result.error?.includes('argument')) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid function parameters',
            details: result.error,
            hint: 'Check the function signature and parameter types'
          })
        }

        return res.status(500).json({
          code: 'PGRST000',
          message: 'Function execution failed',
          details: result.error,
          hint: 'Check the function implementation and database logs'
        })
      }

      // Format and return the response
      const formattedResponse = this.rpcService.formatFunctionResponse(result)
      
      // Set PostgREST-compatible headers
      res.setHeader('Content-Type', 'application/json')
      
      // Add execution time header for debugging
      if (result.executionTime) {
        res.setHeader('X-Execution-Time', result.executionTime.toString())
      }

      // Add row count header for set-returning functions
      if (result.rowCount > 0) {
        res.setHeader('Content-Range', `0-${result.rowCount - 1}/${result.rowCount}`)
      }

      res.status(200).json(formattedResponse)
    } catch (error) {
      console.error(`RPC function call failed for ${functionName}:`, error)
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Check server logs for more details'
      })
    }
  }

  /**
   * Handle function discovery requests
   * Requirements: 1.1
   */
  private async handleFunctionDiscovery(req: NextApiRequest, res: NextApiResponse): Promise<void> {
    if (!this.enhancedConfig?.enableRPCFunctions) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'RPC functions not enabled',
        details: 'RPC function support is disabled for this project',
        hint: 'Enable RPC functions in project configuration'
      })
    }

    try {
      const schema = (req.query.schema as string) || 'public'
      const functions = await this.rpcService.discoverFunctions(this.projectContext, schema)
      
      res.setHeader('Content-Type', 'application/json')
      res.status(200).json({
        schema,
        functions: functions.map(func => ({
          name: func.name,
          schema: func.schema,
          parameters: func.parameters,
          returnType: func.returnType,
          isSetReturning: func.isSetReturning,
          description: func.description,
          endpoint: `/rpc/${func.name}`
        }))
      })
    } catch (error) {
      console.error('Function discovery failed:', error)
      res.status(500).json({
        code: 'PGRST000',
        message: 'Function discovery failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Extract parameters from RPC request body
   * Requirements: 1.2
   */
  private extractRPCParameters(body: any): any[] {
    if (!body) {
      return []
    }

    // If body is an array, use it directly
    if (Array.isArray(body)) {
      return body
    }

    // If body is an object, extract values in order
    if (typeof body === 'object') {
      // If it has numeric keys (0, 1, 2, ...), use them in order
      const numericKeys = Object.keys(body)
        .filter(key => /^\d+$/.test(key))
        .map(key => parseInt(key, 10))
        .sort((a, b) => a - b)

      if (numericKeys.length > 0) {
        return numericKeys.map(key => body[key.toString()])
      }

      // Otherwise, use object values in key order
      return Object.values(body)
    }

    // For primitive values, wrap in array
    return [body]
  }

  /**
   * Handle database view queries
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
   */
  private async handleViewQuery(req: NextApiRequest, res: NextApiResponse, viewName: string): Promise<void> {
    if (!this.enhancedConfig?.enableDatabaseViews) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'Database views not enabled',
        details: 'Database view support is disabled for this project',
        hint: 'Enable database views in project configuration'
      })
    }

    try {
      // Get the schema from query parameters or use default
      const schema = (req.query.schema as string) || 'public'
      
      // Check if the resource is actually a view
      const isView = await this.viewService.isView(this.projectContext, viewName, schema)
      if (!isView) {
        // If it's not a view, fall back to regular table handling
        await this.handleRequest(req, res, viewName)
        return
      }

      // Parse query parameters for view operations
      const queryParams = this.parseViewQueryParams(req)
      
      // Handle different HTTP methods
      switch (req.method) {
        case 'GET':
          await this.handleViewSelect(req, res, viewName, queryParams, schema)
          break
        
        case 'POST':
          await this.handleViewInsert(req, res, viewName, schema)
          break
        
        case 'PATCH':
          await this.handleViewUpdate(req, res, viewName, queryParams, schema)
          break
        
        case 'DELETE':
          await this.handleViewDelete(req, res, viewName, queryParams, schema)
          break
        
        case 'OPTIONS':
          await this.handleViewOptions(req, res, viewName, schema)
          break
        
        default:
          return res.status(405).json({
            code: 'PGRST105',
            message: 'Method not allowed',
            details: `Method ${req.method} is not supported for views`,
            hint: 'Use GET, POST, PATCH, DELETE, or OPTIONS'
          })
      }
    } catch (error) {
      console.error(`View query failed for ${viewName}:`, error)
      
      if (error instanceof Error) {
        if (error.message.includes('does not exist')) {
          return res.status(404).json({
            code: 'PGRST116',
            message: 'Could not find the view in the schema cache',
            details: error.message,
            hint: 'Verify that the view exists and is accessible'
          })
        }
        
        if (error.message.includes('permission denied') || error.message.includes('Permission denied')) {
          return res.status(403).json({
            code: 'PGRST301',
            message: 'Permission denied',
            details: error.message,
            hint: 'Check that the database user has the required permissions on the view'
          })
        }
      }
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'View operation failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Check server logs for more details'
      })
    }
  }

  /**
   * Handle view SELECT operations
   * Requirements: 2.1, 2.2, 2.4, 2.5
   */
  private async handleViewSelect(
    req: NextApiRequest,
    res: NextApiResponse,
    viewName: string,
    queryParams: ViewQueryParams,
    schema: string
  ): Promise<void> {
    try {
      const result = await this.viewService.handleViewQuery(
        this.projectContext,
        viewName,
        queryParams,
        schema
      )

      if (!result.success) {
        throw new Error(result.error)
      }

      // Set PostgREST-compatible headers
      res.setHeader('Content-Type', 'application/json')
      
      // Add execution time header for debugging
      if (result.executionTime) {
        res.setHeader('X-Execution-Time', result.executionTime.toString())
      }

      // Add row count headers
      if (result.totalCount !== undefined) {
        const start = queryParams.offset || 0
        const end = start + result.rowCount - 1
        res.setHeader('Content-Range', `${start}-${end}/${result.totalCount}`)
      } else if (result.rowCount > 0) {
        const start = queryParams.offset || 0
        const end = start + result.rowCount - 1
        res.setHeader('Content-Range', `${start}-${end}/*`)
      }

      // Add view metadata headers
      if (result.view) {
        res.setHeader('X-View-Name', result.view.name)
        res.setHeader('X-View-Schema', result.view.schema)
        res.setHeader('X-View-Updatable', result.view.isUpdatable.toString())
        res.setHeader('X-View-Insertable', result.view.isInsertable.toString())
      }

      res.status(200).json(result.data)
    } catch (error) {
      throw error // Re-throw to be handled by the main error handler
    }
  }

  /**
   * Handle view INSERT operations
   * Requirements: 2.1, 2.3
   */
  private async handleViewInsert(
    req: NextApiRequest,
    res: NextApiResponse,
    viewName: string,
    schema: string
  ): Promise<void> {
    // Validate view access for INSERT
    const validation = await this.viewService.validateViewAccess(
      this.projectContext,
      viewName,
      'INSERT',
      schema
    )

    if (!validation.isValid) {
      const statusCode = validation.code === 'PGRST116' ? 404 : 
                        validation.code === 'PGRST301' ? 403 : 500
      return res.status(statusCode).json({
        code: validation.code,
        message: validation.error,
        details: validation.error,
        hint: 'Check view definition and permissions'
      })
    }

    // For insertable views, proxy to the container for proper handling
    await this.containerClient.proxyRequest(req, res, this.projectContext.projectRef, `/${viewName}`)
  }

  /**
   * Handle view UPDATE operations
   * Requirements: 2.1, 2.3
   */
  private async handleViewUpdate(
    req: NextApiRequest,
    res: NextApiResponse,
    viewName: string,
    queryParams: ViewQueryParams,
    schema: string
  ): Promise<void> {
    // Validate view access for UPDATE
    const validation = await this.viewService.validateViewAccess(
      this.projectContext,
      viewName,
      'UPDATE',
      schema
    )

    if (!validation.isValid) {
      const statusCode = validation.code === 'PGRST116' ? 404 : 
                        validation.code === 'PGRST301' ? 403 : 500
      return res.status(statusCode).json({
        code: validation.code,
        message: validation.error,
        details: validation.error,
        hint: 'Check view definition and permissions'
      })
    }

    // For updatable views, proxy to the container for proper handling
    await this.containerClient.proxyRequest(req, res, this.projectContext.projectRef, `/${viewName}`)
  }

  /**
   * Handle view DELETE operations
   * Requirements: 2.1, 2.3
   */
  private async handleViewDelete(
    req: NextApiRequest,
    res: NextApiResponse,
    viewName: string,
    queryParams: ViewQueryParams,
    schema: string
  ): Promise<void> {
    // Validate view access for DELETE
    const validation = await this.viewService.validateViewAccess(
      this.projectContext,
      viewName,
      'DELETE',
      schema
    )

    if (!validation.isValid) {
      const statusCode = validation.code === 'PGRST116' ? 404 : 
                        validation.code === 'PGRST301' ? 403 : 500
      return res.status(statusCode).json({
        code: validation.code,
        message: validation.error,
        details: validation.error,
        hint: 'Check view definition and permissions'
      })
    }

    // For deletable views, proxy to the container for proper handling
    await this.containerClient.proxyRequest(req, res, this.projectContext.projectRef, `/${viewName}`)
  }

  /**
   * Handle view OPTIONS operations (schema introspection)
   * Requirements: 2.1, 2.4
   */
  private async handleViewOptions(
    req: NextApiRequest,
    res: NextApiResponse,
    viewName: string,
    schema: string
  ): Promise<void> {
    try {
      const view = await this.viewService.getView(this.projectContext, viewName, schema)
      
      if (!view) {
        return res.status(404).json({
          code: 'PGRST116',
          message: 'Could not find the view in the schema cache',
          details: `View "${viewName}" does not exist in schema "${schema}"`,
          hint: 'Verify that the view exists and is accessible'
        })
      }

      // Get computed columns
      const computedColumns = await this.viewService.getComputedColumns(
        this.projectContext,
        viewName,
        schema
      )

      // Build view schema information
      const viewSchema = {
        name: view.name,
        schema: view.schema,
        definition: view.definition,
        isUpdatable: view.isUpdatable,
        isInsertable: view.isInsertable,
        isTriggerUpdatable: view.isTriggerUpdatable,
        isTriggerDeletable: view.isTriggerDeletable,
        isTriggerInsertable: view.isTriggerInsertable,
        description: view.description,
        columns: view.columns.map(col => ({
          name: col.name,
          type: col.type,
          udtName: col.udtName,
          isNullable: col.isNullable,
          defaultValue: col.defaultValue,
          ordinalPosition: col.ordinalPosition,
          characterMaximumLength: col.characterMaximumLength,
          numericPrecision: col.numericPrecision,
          numericScale: col.numericScale,
          isIdentity: col.isIdentity,
          isGenerated: col.isGenerated,
          generationExpression: col.generationExpression,
          isComputed: computedColumns.some(cc => cc.name === col.name)
        })),
        permissions: view.permissions,
        computedColumns: computedColumns.map(col => col.name)
      }

      res.setHeader('Content-Type', 'application/json')
      res.status(200).json(viewSchema)
    } catch (error) {
      throw error // Re-throw to be handled by the main error handler
    }
  }

  /**
   * Parse view query parameters from HTTP request
   * Requirements: 2.2, 2.5
   */
  private parseViewQueryParams(req: NextApiRequest): ViewQueryParams {
    const query = req.query
    const params: ViewQueryParams = {}

    // Parse select parameter
    if (query.select && typeof query.select === 'string') {
      params.select = query.select.split(',').map(col => col.trim())
    }

    // Parse filters
    const filters: ViewFilter[] = []
    for (const [key, value] of Object.entries(query)) {
      if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset' || key === 'count' || key === 'schema' || key === 'path' || key === 'ref') {
        continue
      }

      // Parse filter operators
      const parts = key.split('.')
      if (parts.length >= 2) {
        const column = parts[0]
        const operator = parts[1] as ViewFilter['operator']
        
        if (['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is'].includes(operator)) {
          let filterValue: any = value
          
          // Handle array values for 'in' operator
          if (operator === 'in' && typeof value === 'string') {
            filterValue = value.split(',').map(v => v.trim())
          }
          
          // Handle boolean and null values for 'is' operator
          if (operator === 'is') {
            if (value === 'null') filterValue = null
            else if (value === 'true') filterValue = true
            else if (value === 'false') filterValue = false
          }

          filters.push({
            column,
            operator,
            value: filterValue
          })
        }
      } else {
        // Default to equality filter
        filters.push({
          column: key,
          operator: 'eq',
          value
        })
      }
    }
    
    if (filters.length > 0) {
      params.filters = filters
    }

    // Parse order parameter
    if (query.order && typeof query.order === 'string') {
      const orderClauses = query.order.split(',').map(clause => {
        const parts = clause.trim().split('.')
        const column = parts[0]
        const direction = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
        return { column, direction } as ViewOrder
      })
      params.order = orderClauses
    }

    // Parse limit and offset
    if (query.limit && typeof query.limit === 'string') {
      const limit = parseInt(query.limit, 10)
      if (!isNaN(limit) && limit > 0) {
        params.limit = limit
      }
    }

    if (query.offset && typeof query.offset === 'string') {
      const offset = parseInt(query.offset, 10)
      if (!isNaN(offset) && offset >= 0) {
        params.offset = offset
      }
    }

    // Parse count parameter
    if (query.count) {
      params.count = query.count === 'true' || query.count === '1'
    }

    return params
  }

  /**
   * Check if request contains JSON operations
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   */
  private hasJSONOperations(req: NextApiRequest): boolean {
    if (!this.enhancedConfig?.enableAdvancedJSON) {
      return false
    }

    const query = req.query
    
    // Use the JSON query service to parse and detect JSON operators
    const jsonFilters = this.jsonQueryService.parseJSONOperators(query)
    return jsonFilters.length > 0
  }

  /**
   * Handle JSON query operations
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   */
  private async handleJSONQuery(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    if (!this.enhancedConfig?.enableAdvancedJSON) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'Advanced JSON operations not enabled',
        details: 'Advanced JSON operation support is disabled for this project',
        hint: 'Enable advanced JSON operations in project configuration'
      })
    }

    try {
      // Only handle GET requests for JSON queries
      if (req.method !== 'GET') {
        return res.status(405).json({
          code: 'PGRST105',
          message: 'Method not allowed',
          details: 'JSON operations are only supported for GET requests',
          hint: 'Use GET method for JSON queries'
        })
      }

      // Parse JSON operators from query parameters
      const jsonFilters = this.jsonQueryService.parseJSONOperators(req.query)
      
      if (jsonFilters.length === 0) {
        // No JSON operations found, fall back to regular handling
        await this.handleRequest(req, res, tableName)
        return
      }

      // Validate JSON filters
      for (const filter of jsonFilters) {
        if (filter.jsonPath) {
          const validation = this.jsonQueryService.validateJSONPath(filter.jsonPath)
          if (!validation.isValid) {
            return res.status(400).json({
              code: 'PGRST103',
              message: 'Invalid JSON path',
              details: validation.error,
              hint: 'Check the JSON path syntax'
            })
          }
        }
      }

      // Parse other query parameters
      const selectColumns = this.parseSelectColumns(req.query.select as string)
      const orderBy = req.query.order as string
      const limit = this.parseLimit(req.query.limit as string)
      const offset = this.parseOffset(req.query.offset as string)

      // Execute JSON query
      const result = await this.jsonQueryService.executeJSONQuery(
        this.projectContext,
        tableName,
        jsonFilters,
        selectColumns,
        orderBy,
        limit,
        offset
      )

      if (!result.success) {
        // Handle specific error types
        if (result.error?.includes('does not exist')) {
          return res.status(404).json({
            code: 'PGRST116',
            message: 'Could not find the table in the schema cache',
            details: result.error,
            hint: 'Verify that the table exists and is accessible'
          })
        }

        if (result.error?.includes('permission denied') || result.error?.includes('Permission denied')) {
          return res.status(403).json({
            code: 'PGRST301',
            message: 'Permission denied',
            details: result.error,
            hint: 'Check that the database user has the required permissions on the table'
          })
        }

        if (result.error?.includes('column') && result.error?.includes('does not exist')) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid column reference',
            details: result.error,
            hint: 'Check that all referenced columns exist in the table'
          })
        }

        return res.status(500).json({
          code: 'PGRST000',
          message: 'JSON query execution failed',
          details: result.error,
          hint: 'Check server logs for more details'
        })
      }

      // Set PostgREST-compatible headers
      res.setHeader('Content-Type', 'application/json')
      
      // Add execution time header for debugging
      if (result.executionTime) {
        res.setHeader('X-Execution-Time', result.executionTime.toString())
      }

      // Add row count headers
      if (result.rowCount !== undefined && result.rowCount > 0) {
        const start = offset || 0
        const end = start + result.rowCount - 1
        res.setHeader('Content-Range', `${start}-${end}/*`)
      }

      // Add JSON operation metadata headers
      res.setHeader('X-JSON-Filters', jsonFilters.length.toString())
      res.setHeader('X-JSON-Operations', jsonFilters.map(f => f.operator).join(','))

      res.status(200).json(result.data)
    } catch (error) {
      console.error(`JSON query failed for ${tableName}:`, error)
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'JSON query operation failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Check server logs for more details'
      })
    }
  }

  /**
   * Parse select columns from query parameter
   */
  private parseSelectColumns(selectParam?: string): string[] | undefined {
    if (!selectParam || typeof selectParam !== 'string') {
      return undefined
    }

    return selectParam.split(',').map(col => col.trim()).filter(col => col.length > 0)
  }

  /**
   * Parse limit from query parameter
   */
  private parseLimit(limitParam?: string): number | undefined {
    if (!limitParam || typeof limitParam !== 'string') {
      return undefined
    }

    const limit = parseInt(limitParam, 10)
    return isNaN(limit) || limit <= 0 ? undefined : Math.min(limit, 1000) // Cap at 1000
  }

  /**
   * Parse offset from query parameter
   */
  private parseOffset(offsetParam?: string): number | undefined {
    if (!offsetParam || typeof offsetParam !== 'string') {
      return undefined
    }

    const offset = parseInt(offsetParam, 10)
    return isNaN(offset) || offset < 0 ? undefined : offset
  }

  /**
   * Check if request contains full-text search operations
   * Requirements: 4.1, 4.2, 4.3, 4.4
   */
  private hasFullTextSearchOperations(req: NextApiRequest): boolean {
    if (!this.enhancedConfig?.enableFullTextSearch) {
      return false
    }

    const query = req.query
    
    // Use the full-text search service to parse and detect FTS operators
    const ftsFilters = this.fullTextSearchService.parseFullTextSearchOperators(query)
    return ftsFilters.length > 0
  }

  /**
   * Handle full-text search query operations
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
   */
  private async handleFullTextSearchQuery(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    if (!this.enhancedConfig?.enableFullTextSearch) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'Full-text search not enabled',
        details: 'Full-text search support is disabled for this project',
        hint: 'Enable full-text search in project configuration'
      })
    }

    try {
      // Only handle GET requests for full-text search queries
      if (req.method !== 'GET') {
        return res.status(405).json({
          code: 'PGRST105',
          message: 'Method not allowed',
          details: 'Full-text search operations are only supported for GET requests',
          hint: 'Use GET method for full-text search queries'
        })
      }

      // Parse full-text search operators from query parameters
      const ftsFilters = this.fullTextSearchService.parseFullTextSearchOperators(req.query)
      
      if (ftsFilters.length === 0) {
        // No FTS operations found, fall back to regular handling
        await this.handleRequest(req, res, tableName)
        return
      }

      // Parse other query parameters
      const selectColumns = this.parseSelectColumns(req.query.select as string)
      const orderBy = req.query.order as string
      const limit = this.parseLimit(req.query.limit as string)
      const offset = this.parseOffset(req.query.offset as string)
      const includeRanking = req.query.rank === 'true' || req.query.rank === '1'

      // Execute full-text search query
      const result = await this.fullTextSearchService.executeFullTextSearchQuery(
        this.projectContext,
        tableName,
        ftsFilters,
        selectColumns,
        orderBy,
        limit,
        offset,
        includeRanking
      )

      if (!result.success) {
        // Handle specific error types
        if (result.error?.includes('does not exist')) {
          return res.status(404).json({
            code: 'PGRST116',
            message: 'Could not find the table in the schema cache',
            details: result.error,
            hint: 'Verify that the table exists and is accessible'
          })
        }

        if (result.error?.includes('permission denied') || result.error?.includes('Permission denied')) {
          return res.status(403).json({
            code: 'PGRST301',
            message: 'Permission denied',
            details: result.error,
            hint: 'Check that the database user has the required permissions on the table'
          })
        }

        if (result.error?.includes('column') && result.error?.includes('does not exist')) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid column reference',
            details: result.error,
            hint: 'Check that all referenced columns exist in the table'
          })
        }

        return res.status(500).json({
          code: 'PGRST000',
          message: 'Full-text search query execution failed',
          details: result.error,
          hint: 'Check server logs for more details'
        })
      }

      // Set PostgREST-compatible headers
      res.setHeader('Content-Type', 'application/json')
      
      // Add execution time header for debugging
      if (result.executionTime) {
        res.setHeader('X-Execution-Time', result.executionTime.toString())
      }

      // Add row count headers
      if (result.rowCount !== undefined && result.rowCount > 0) {
        const start = offset || 0
        const end = start + result.rowCount - 1
        res.setHeader('Content-Range', `${start}-${end}/*`)
      }

      // Add full-text search metadata headers
      res.setHeader('X-FTS-Filters', ftsFilters.length.toString())
      res.setHeader('X-FTS-Operations', ftsFilters.map(f => f.operator).join(','))

      // Add performance warnings if any
      if (result.performanceWarnings && result.performanceWarnings.length > 0) {
        res.setHeader('X-Performance-Warnings', result.performanceWarnings.join('; '))
      }

      res.status(200).json(result.data)
    } catch (error) {
      console.error(`Full-text search query failed for ${tableName}:`, error)
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Full-text search operation failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Check server logs for more details'
      })
    }
  }

  /**
   * Check if request contains aggregate operations
   * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
   */
  private hasAggregateOperations(req: NextApiRequest): boolean {
    if (!this.enhancedConfig?.enableAggregateQueries) {
      return false
    }

    const selectParam = req.query.select as string
    if (!selectParam) {
      return false
    }

    // Check for aggregate functions in select parameter
    const aggregatePattern = /(count|sum|avg|min|max)\s*\(/i
    return aggregatePattern.test(selectParam)
  }

  /**
   * Handle aggregate query operations
   * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
   */
  private async handleAggregateQuery(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    if (!this.enhancedConfig?.enableAggregateQueries) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'Aggregate queries not enabled',
        details: 'Aggregate query support is disabled for this project',
        hint: 'Enable aggregate queries in project configuration'
      })
    }

    try {
      // Only handle GET requests for aggregate queries
      if (req.method !== 'GET') {
        return res.status(405).json({
          code: 'PGRST105',
          message: 'Method not allowed',
          details: 'Aggregate operations are only supported for GET requests',
          hint: 'Use GET method for aggregate queries'
        })
      }

      const selectParam = req.query.select as string
      if (!selectParam) {
        return res.status(400).json({
          code: 'PGRST103',
          message: 'Missing select parameter',
          details: 'Aggregate queries require a select parameter with aggregate functions',
          hint: 'Use select parameter with functions like count(*), sum(column), avg(column)'
        })
      }

      // Parse aggregate operations from select parameter
      const aggregateOps = this.aggregateQueryService.parseAggregateOperations(selectParam)
      
      if (aggregateOps.length === 0) {
        // No aggregate operations found, fall back to regular handling
        await this.handleRequest(req, res, tableName)
        return
      }

      // Parse GROUP BY clause
      const groupBy = this.aggregateQueryService.parseGroupBy(req.query)

      // Parse WHERE filters
      const whereFilters = this.aggregateQueryService.parseWhereFilters(req.query)

      // Parse HAVING filters
      const havingFilters = this.aggregateQueryService.parseHavingClause(req.query)

      // Parse other query parameters
      const orderBy = req.query.order as string
      const limit = this.parseLimit(req.query.limit as string)
      const offset = this.parseOffset(req.query.offset as string)

      // Validate aggregate operations
      for (const op of aggregateOps) {
        if (op.column !== '*' && !this.isValidColumnName(op.column)) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid column reference',
            details: `Invalid column name in aggregate function: ${op.column}`,
            hint: 'Check that all referenced columns exist in the table'
          })
        }
      }

      // Validate GROUP BY columns
      for (const col of groupBy) {
        if (!this.isValidColumnName(col)) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid column reference',
            details: `Invalid column name in GROUP BY clause: ${col}`,
            hint: 'Check that all GROUP BY columns exist in the table'
          })
        }
      }

      // Execute aggregate query
      const result = await this.aggregateQueryService.executeAggregateQuery(
        this.projectContext,
        tableName,
        aggregateOps,
        groupBy,
        whereFilters,
        havingFilters,
        orderBy,
        limit,
        offset
      )

      if (!result.success) {
        // Handle specific error types
        if (result.error?.includes('does not exist')) {
          return res.status(404).json({
            code: 'PGRST116',
            message: 'Could not find the table in the schema cache',
            details: result.error,
            hint: 'Verify that the table exists and is accessible'
          })
        }

        if (result.error?.includes('permission denied') || result.error?.includes('Permission denied')) {
          return res.status(403).json({
            code: 'PGRST301',
            message: 'Permission denied',
            details: result.error,
            hint: 'Check that the database user has the required permissions on the table'
          })
        }

        if (result.error?.includes('column') && result.error?.includes('does not exist')) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid column reference',
            details: result.error,
            hint: 'Check that all referenced columns exist in the table'
          })
        }

        if (result.error?.includes('aggregate function') || result.error?.includes('must appear in the GROUP BY')) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid aggregate query',
            details: result.error,
            hint: 'All non-aggregate columns must appear in the GROUP BY clause'
          })
        }

        return res.status(500).json({
          code: 'PGRST000',
          message: 'Aggregate query execution failed',
          details: result.error,
          hint: 'Check server logs for more details'
        })
      }

      // Set PostgREST-compatible headers
      res.setHeader('Content-Type', 'application/json')
      
      // Add execution time header for debugging
      if (result.executionTime) {
        res.setHeader('X-Execution-Time', result.executionTime.toString())
      }

      // Add row count headers for pagination
      if (result.totalCount !== undefined && result.rowCount !== undefined) {
        const start = offset || 0
        const end = start + result.rowCount - 1
        res.setHeader('Content-Range', `${start}-${end}/${result.totalCount}`)
      } else if (result.rowCount !== undefined && result.rowCount > 0) {
        const start = offset || 0
        const end = start + result.rowCount - 1
        res.setHeader('Content-Range', `${start}-${end}/*`)
      }

      // Add aggregate operation metadata headers
      res.setHeader('X-Aggregate-Functions', aggregateOps.length.toString())
      res.setHeader('X-Aggregate-Operations', aggregateOps.map(op => `${op.function}(${op.column})`).join(','))
      
      if (groupBy.length > 0) {
        res.setHeader('X-Group-By-Columns', groupBy.join(','))
      }

      if (havingFilters.length > 0) {
        res.setHeader('X-Having-Filters', havingFilters.length.toString())
      }

      res.status(200).json(result.data)
    } catch (error) {
      console.error(`Aggregate query failed for ${tableName}:`, error)
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Aggregate query operation failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Check server logs for more details'
      })
    }
  }

  /**
   * Validate column name (helper method)
   */
  private isValidColumnName(name: string): boolean {
    if (!name || typeof name !== 'string') return false
    // Allow alphanumeric, underscore, and dollar sign (common in PostgreSQL)
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
  }

  /**
   * Check if request requires response shaping
   * Requirements: 6.1, 6.2, 6.3, 6.4
   */
  private requiresResponseShaping(req: NextApiRequest): boolean {
    if (!this.enhancedConfig?.enableResponseShaping) {
      return false
    }

    const selectParam = req.query.select as string
    const acceptHeader = req.headers.accept

    // Simple column selection should be handled by base engine
    // Only treat as response shaping if it has advanced features
    
    // Check for computed columns (contains colon)
    const hasComputedColumns = Boolean(selectParam && selectParam.includes(':'))
    
    // Check for nested resource selection (contains parentheses)
    const hasNestedSelection = Boolean(selectParam && selectParam.includes('('))
    
    // Check for wildcard exclusion (contains exclamation mark)
    const hasWildcardExclusion = Boolean(selectParam && selectParam.includes('!'))
    
    // Check for content negotiation
    const hasContentNegotiation = Boolean(acceptHeader && (
      acceptHeader.includes('text/csv') || 
      acceptHeader.includes('application/vnd.pgrst.object+json') ||
      acceptHeader.includes('application/geo+json')
    ))

    return hasComputedColumns || 
           hasNestedSelection || 
           hasWildcardExclusion || 
           hasContentNegotiation
  }

  /**
   * Handle response shaping operations
   * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
   */
  private async handleResponseShaping(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    if (!this.enhancedConfig?.enableResponseShaping) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'Response shaping not enabled',
        details: 'Response shaping support is disabled for this project',
        hint: 'Enable response shaping in project configuration'
      })
    }

    try {
      // Only handle GET requests for response shaping
      if (req.method !== 'GET') {
        return res.status(405).json({
          code: 'PGRST105',
          message: 'Method not allowed',
          details: 'Response shaping is only supported for GET requests',
          hint: 'Use GET method for response shaping queries'
        })
      }

      const selectParam = req.query.select as string
      const acceptHeader = req.headers.accept
      const schema = (req.query.schema as string) || 'public'

      // Parse select criteria
      const criteria = this.responseShapingService.parseSelectParameter(selectParam || '*')
      
      // Validate column selection
      const validation = await this.responseShapingService.validateColumnSelection(
        this.projectContext,
        tableName,
        criteria,
        schema
      )

      if (!validation.isValid) {
        // Handle specific validation errors
        if (validation.code === 'PGRST116') {
          return res.status(404).json({
            code: validation.code,
            message: 'Could not find the table in the schema cache',
            details: validation.error,
            hint: 'Verify that the table exists and is accessible'
          })
        }

        if (validation.code === 'PGRST103') {
          return res.status(400).json({
            code: validation.code,
            message: 'Invalid column selection',
            details: validation.error,
            hint: 'Check that all referenced columns exist in the table',
            invalidColumns: validation.invalidColumns
          })
        }

        return res.status(500).json({
          code: 'PGRST000',
          message: 'Column validation failed',
          details: validation.error,
          hint: 'Check server logs for more details'
        })
      }

      // Build enhanced SQL query with response shaping
      const selectClause = this.responseShapingService.buildSelectClause(criteria, validation.tableSchema!)
      
      // Parse other query parameters for filtering, ordering, etc.
      const whereClause = this.buildWhereClause(req.query)
      const orderClause = this.buildOrderClause(req.query.order as string)
      const limit = this.parseLimit(req.query.limit as string)
      const offset = this.parseOffset(req.query.offset as string)

      // Build the complete SQL query
      let query = `SELECT ${selectClause} FROM "${schema}"."${tableName}"`
      const queryParams: any[] = []
      let paramIndex = 1

      if (whereClause.clause) {
        query += ` WHERE ${whereClause.clause}`
        queryParams.push(...whereClause.params)
        paramIndex += whereClause.params.length
      }

      if (orderClause) {
        query += ` ORDER BY ${orderClause}`
      }

      if (limit) {
        query += ` LIMIT $${paramIndex}`
        queryParams.push(limit)
        paramIndex++
      }

      if (offset) {
        query += ` OFFSET $${paramIndex}`
        queryParams.push(offset)
      }

      // Execute the query
      const projectDbClient = getProjectDatabaseClient()
      const result = await projectDbClient.queryProjectDatabase(
        this.projectContext.projectRef,
        this.projectContext.userId,
        query,
        queryParams,
        { skipPermissionCheck: false }
      )

      // Apply content negotiation first
      const negotiationResult = this.contentNegotiationService.negotiateContentType(acceptHeader)
      
      if (!negotiationResult.isSupported) {
        const error = this.contentNegotiationService.createUnsupportedFormatError(acceptHeader || '')
        return res.status(error.statusCode).json({
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        })
      }

      // Apply format-specific optimizations
      const optimizationResult = this.contentNegotiationService.applyFormatOptimizations(
        result.rows,
        negotiationResult.format!
      )

      // Format the response
      const formatResult = this.contentNegotiationService.formatResponse(
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
      this.contentNegotiationService.setResponseHeaders(
        res,
        negotiationResult.format!,
        negotiationResult.contentType!,
        typeof formatResult.data === 'string' ? formatResult.data.length : undefined
      )

      // Add pagination headers
      const paginationHeaders = this.responseShapingService.generatePaginationHeaders(
        result.rows,
        undefined, // We don't have total count in this simple implementation
        limit,
        offset
      )

      for (const [key, value] of Object.entries(paginationHeaders)) {
        res.setHeader(key, value)
      }

      // Add content negotiation metadata headers
      res.setHeader('X-Response-Format', negotiationResult.format!)
      res.setHeader('X-Original-Rows', result.rows.length.toString())
      res.setHeader('X-Optimized-Rows', optimizationResult.optimizedSize.toString())
      
      if (optimizationResult.appliedOptimizations.length > 0) {
        res.setHeader('X-Applied-Optimizations', optimizationResult.appliedOptimizations.join(','))
      }

      // Return the formatted response
      if (negotiationResult.format === 'csv') {
        res.status(200).send(formatResult.data)
      } else {
        res.status(200).json(formatResult.data)
      }
    } catch (error) {
      console.error(`Response shaping failed for ${tableName}:`, error)
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Response shaping operation failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Check server logs for more details'
      })
    }
  }

  /**
   * Build WHERE clause from query parameters
   */
  private buildWhereClause(query: any): { clause: string; params: any[] } {
    const conditions: string[] = []
    const params: any[] = []
    let paramIndex = 1

    for (const [key, value] of Object.entries(query)) {
      // Skip non-filter parameters
      if (['select', 'order', 'limit', 'offset', 'count', 'schema', 'path'].includes(key)) {
        continue
      }

      // Parse filter operators
      const parts = key.split('.')
      if (parts.length >= 2) {
        const column = parts[0]
        const operator = parts[1]
        
        switch (operator) {
          case 'eq':
            conditions.push(`"${column}" = $${paramIndex}`)
            params.push(value)
            paramIndex++
            break
          case 'neq':
            conditions.push(`"${column}" != $${paramIndex}`)
            params.push(value)
            paramIndex++
            break
          case 'gt':
            conditions.push(`"${column}" > $${paramIndex}`)
            params.push(value)
            paramIndex++
            break
          case 'gte':
            conditions.push(`"${column}" >= $${paramIndex}`)
            params.push(value)
            paramIndex++
            break
          case 'lt':
            conditions.push(`"${column}" < $${paramIndex}`)
            params.push(value)
            paramIndex++
            break
          case 'lte':
            conditions.push(`"${column}" <= $${paramIndex}`)
            params.push(value)
            paramIndex++
            break
          case 'like':
            conditions.push(`"${column}" LIKE $${paramIndex}`)
            params.push(value)
            paramIndex++
            break
          case 'ilike':
            conditions.push(`"${column}" ILIKE $${paramIndex}`)
            params.push(value)
            paramIndex++
            break
          case 'in':
            if (typeof value === 'string') {
              const values = value.split(',').map(v => v.trim())
              const placeholders = values.map(() => `$${paramIndex++}`).join(',')
              conditions.push(`"${column}" IN (${placeholders})`)
              params.push(...values)
            }
            break
          case 'is':
            if (value === 'null') {
              conditions.push(`"${column}" IS NULL`)
            } else if (value === 'true') {
              conditions.push(`"${column}" IS TRUE`)
            } else if (value === 'false') {
              conditions.push(`"${column}" IS FALSE`)
            }
            break
        }
      } else {
        // Handle PostgREST-style filters (e.g., "id=eq.1" or just "id=1")
        if (typeof value === 'string' && value.startsWith('eq.')) {
          conditions.push(`"${key}" = $${paramIndex}`)
          params.push(value.substring(3)) // Remove 'eq.' prefix
          paramIndex++
        } else {
          // Default to equality filter
          conditions.push(`"${key}" = $${paramIndex}`)
          params.push(value)
          paramIndex++
        }
      }
    }

    return {
      clause: conditions.length > 0 ? conditions.join(' AND ') : '',
      params
    }
  }

  /**
   * Build ORDER BY clause from order parameter
   */
  private buildOrderClause(orderParam?: string): string {
    if (!orderParam || typeof orderParam !== 'string') {
      return ''
    }

    const orderClauses = orderParam.split(',').map(clause => {
      const parts = clause.trim().split('.')
      const column = parts[0]
      const direction = parts[1]?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
      return `"${column}" ${direction}`
    })

    return orderClauses.join(', ')
  }

  /**
   * Check if request contains advanced filtering operations
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
   */
  private hasAdvancedFilteringOperations(req: NextApiRequest): boolean {
    if (!this.enhancedConfig?.enableAdvancedFiltering) {
      return false
    }

    const query = req.query
    
    // Check if select parameter contains aggregate functions - should use aggregate path instead
    const selectParam = query.select as string
    if (selectParam) {
      const aggregatePattern = /(count|sum|avg|min|max)\s*\(/i
      if (aggregatePattern.test(selectParam)) {
        return false // Let aggregate handler deal with it
      }
      // Check if select contains nested resources (e.g., "table(columns)")
      // Nested resources have pattern: word(...)
      const nestedPattern = /\w+\s*\([^)]*\)/
      if (nestedPattern.test(selectParam)) {
        return false // Let nested resource handler deal with it
      }
      // Simple select (just column names) should be handled by base engine
      // Don't treat it as advanced filtering
    }
    
    // Use the advanced filtering service to parse and detect advanced operators
    const advancedFilters = this.advancedFilteringService.parseAdvancedFilters(query)
    const logicalGroups = this.advancedFilteringService.parseLogicalOperators(query)
    
    // Only return true if there are actual advanced filters or logical groups
    // Simple filters like ?id=eq.1 should be handled by base engine
    return advancedFilters.length > 0 || logicalGroups.length > 0
  }

  /**
   * Handle advanced filtering query operations
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
   */
  private async handleAdvancedFilteringQuery(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    if (!this.enhancedConfig?.enableAdvancedFiltering) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'Advanced filtering not enabled',
        details: 'Advanced filtering support is disabled for this project',
        hint: 'Enable advanced filtering in project configuration'
      })
    }

    try {
      // Only handle GET requests for advanced filtering queries
      if (req.method !== 'GET') {
        return res.status(405).json({
          code: 'PGRST105',
          message: 'Method not allowed',
          details: 'Advanced filtering operations are only supported for GET requests',
          hint: 'Use GET method for advanced filtering queries'
        })
      }

      // Parse advanced filters from query parameters
      const advancedFilters = this.advancedFilteringService.parseAdvancedFilters(req.query)
      const logicalGroups = this.advancedFilteringService.parseLogicalOperators(req.query)
      
      if (advancedFilters.length === 0 && logicalGroups.length === 0) {
        // No advanced filtering operations found, fall back to regular handling
        await this.handleRequest(req, res, tableName)
        return
      }

      // Parse other query parameters
      const selectColumns = this.parseSelectColumns(req.query.select as string)
      const orderBy = req.query.order as string
      const limit = this.parseLimit(req.query.limit as string)
      const offset = this.parseOffset(req.query.offset as string)
      const schema = (req.query.schema as string) || 'public'

      // Execute advanced filtering query
      const result = await this.advancedFilteringService.executeAdvancedFilterQuery(
        this.projectContext,
        tableName,
        advancedFilters,
        logicalGroups,
        selectColumns,
        orderBy,
        limit,
        offset,
        schema
      )

      if (!result.success) {
        // Handle specific error types
        if (result.error?.includes('does not exist')) {
          return res.status(404).json({
            code: 'PGRST116',
            message: 'Could not find the table in the schema cache',
            details: result.error,
            hint: 'Verify that the table exists and is accessible'
          })
        }

        if (result.error?.includes('permission denied') || result.error?.includes('Permission denied')) {
          return res.status(403).json({
            code: 'PGRST301',
            message: 'Permission denied',
            details: result.error,
            hint: 'Check that the database user has the required permissions on the table'
          })
        }

        if (result.error?.includes('column') && result.error?.includes('does not exist')) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid column reference',
            details: result.error,
            hint: 'Check that all referenced columns exist in the table'
          })
        }

        if (result.error?.includes('Filter validation failed')) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid filter parameters',
            details: result.error,
            hint: 'Check the filter syntax and parameter values'
          })
        }

        return res.status(500).json({
          code: 'PGRST000',
          message: 'Advanced filtering query execution failed',
          details: result.error,
          hint: 'Check server logs for more details'
        })
      }

      // Set PostgREST-compatible headers
      res.setHeader('Content-Type', 'application/json')
      
      // Add execution time header for debugging
      if (result.executionTime) {
        res.setHeader('X-Execution-Time', result.executionTime.toString())
      }

      // Add row count headers
      if (result.rowCount !== undefined && result.rowCount > 0) {
        const start = offset || 0
        const end = start + result.rowCount - 1
        res.setHeader('Content-Range', `${start}-${end}/*`)
      }

      // Add advanced filtering metadata headers
      res.setHeader('X-Advanced-Filters', advancedFilters.length.toString())
      res.setHeader('X-Logical-Groups', logicalGroups.length.toString())
      
      if (advancedFilters.length > 0) {
        res.setHeader('X-Filter-Operations', advancedFilters.map(f => f.operator).join(','))
      }

      if (logicalGroups.length > 0) {
        res.setHeader('X-Logical-Operations', logicalGroups.map(g => g.operator).join(','))
      }

      // Add performance warnings if any
      if (result.warnings && result.warnings.length > 0) {
        res.setHeader('X-Performance-Warnings', result.warnings.join('; '))
      }

      res.status(200).json(result.data)
    } catch (error) {
      console.error(`Advanced filtering query failed for ${tableName}:`, error)
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Advanced filtering operation failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Check server logs for more details'
      })
    }
  }

  /**
   * Check if request contains array operations
   * Requirements: 11.1, 11.2, 11.3
   */
  private hasArrayOperations(req: NextApiRequest): boolean {
    if (!this.enhancedConfig?.enableArrayOperations) {
      return false
    }

    const query = req.query
    
    // Use the array operation service to parse and detect array operators
    const arrayFilters = this.arrayOperationService.parseArrayOperators(query)
    return arrayFilters.length > 0
  }

  /**
   * Handle array operations query
   * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
   */
  private async handleArrayOperationsQuery(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    if (!this.enhancedConfig?.enableArrayOperations) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'Array operations not enabled',
        details: 'Array operation support is disabled for this project',
        hint: 'Enable array operations in project configuration'
      })
    }

    try {
      // Only handle GET requests for array operations
      if (req.method !== 'GET') {
        return res.status(405).json({
          code: 'PGRST105',
          message: 'Method not allowed',
          details: 'Array operations are only supported for GET requests',
          hint: 'Use GET method for array operation queries'
        })
      }

      // Parse array operators from query parameters
      const arrayFilters = this.arrayOperationService.parseArrayOperators(req.query)
      
      if (arrayFilters.length === 0) {
        // No array operations found, fall back to regular handling
        await this.handleRequest(req, res, tableName)
        return
      }

      // Validate array filters
      for (const filter of arrayFilters) {
        const validation = this.arrayOperationService.validateArrayFilter(filter)
        if (!validation.isValid) {
          return res.status(400).json({
            code: validation.code || 'PGRST103',
            message: 'Invalid array operation',
            details: validation.error,
            hint: 'Check the array operation syntax and values'
          })
        }

        // Validate that the column is actually an array type
        const schema = (req.query.schema as string) || 'public'
        const columnValidation = await this.arrayOperationService.validateArrayColumn(
          this.projectContext,
          tableName,
          filter.column,
          schema
        )

        if (!columnValidation.isValid) {
          return res.status(400).json({
            code: columnValidation.code || 'PGRST103',
            message: 'Invalid array column',
            details: columnValidation.error,
            hint: 'Ensure the column exists and is an array type'
          })
        }

        // Check if the array type is supported
        if (columnValidation.columnInfo && !columnValidation.columnInfo.isSupported) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Unsupported array type',
            details: `Array type ${columnValidation.columnInfo.udtName} is not supported`,
            hint: 'Check the supported array types in the documentation'
          })
        }
      }

      // Parse other query parameters
      const selectColumns = this.parseSelectColumns(req.query.select as string)
      const orderBy = req.query.order as string
      const limit = this.parseLimit(req.query.limit as string)
      const offset = this.parseOffset(req.query.offset as string)
      const schema = (req.query.schema as string) || 'public'

      // Execute array operations query
      const result = await this.arrayOperationService.executeArrayQuery(
        this.projectContext,
        tableName,
        arrayFilters,
        selectColumns,
        orderBy,
        limit,
        offset,
        schema
      )

      if (!result.success) {
        // Handle specific error types
        if (result.error?.includes('does not exist')) {
          return res.status(404).json({
            code: 'PGRST116',
            message: 'Could not find the table in the schema cache',
            details: result.error,
            hint: 'Verify that the table exists and is accessible'
          })
        }

        if (result.error?.includes('permission denied') || result.error?.includes('Permission denied')) {
          return res.status(403).json({
            code: 'PGRST301',
            message: 'Permission denied',
            details: result.error,
            hint: 'Check that the database user has the required permissions on the table'
          })
        }

        if (result.error?.includes('column') && result.error?.includes('does not exist')) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid column reference',
            details: result.error,
            hint: 'Check that all referenced columns exist in the table'
          })
        }

        if (result.error?.includes('array') && result.error?.includes('type')) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Array type error',
            details: result.error,
            hint: 'Check that the column is an array type and the operation is valid'
          })
        }

        return res.status(500).json({
          code: 'PGRST000',
          message: 'Array operation query execution failed',
          details: result.error,
          hint: 'Check server logs for more details'
        })
      }

      // Set PostgREST-compatible headers
      res.setHeader('Content-Type', 'application/json')
      
      // Add execution time header for debugging
      if (result.executionTime) {
        res.setHeader('X-Execution-Time', result.executionTime.toString())
      }

      // Add row count headers
      if (result.rowCount !== undefined && result.rowCount > 0) {
        const start = offset || 0
        const end = start + result.rowCount - 1
        res.setHeader('Content-Range', `${start}-${end}/*`)
      }

      // Add array operation metadata headers
      res.setHeader('X-Array-Operations', 'true')
      res.setHeader('X-Array-Filters', arrayFilters.length.toString())
      res.setHeader('X-Array-Operators', arrayFilters.map(f => f.operator).join(','))
      res.setHeader('X-Array-Columns', arrayFilters.map(f => f.column).join(','))

      // Add array operation limits information
      const limits = this.arrayOperationService.getArrayOperationLimits()
      res.setHeader('X-Array-Max-Size', limits.maxArraySize.toString())
      res.setHeader('X-Array-Max-Index', limits.maxIndexValue.toString())

      res.status(200).json(result.data)
    } catch (error) {
      console.error(`Array operations query failed for ${tableName}:`, error)
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Array operations failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Check server logs for more details'
      })
    }
  }

  /**
   * Check if request is a bulk operation
   * Requirements: 8.1, 8.2
   */
  private isBulkOperation(req: NextApiRequest): boolean {
    if (!this.enhancedConfig?.enableBulkOperations) {
      return false
    }

    return this.bulkOperationService.isBulkOperation(req)
  }

  /**
   * Handle bulk operation requests
   * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
   */
  private async handleBulkOperation(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    if (!this.enhancedConfig?.enableBulkOperations) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'Bulk operations not enabled',
        details: 'Bulk operation support is disabled for this project',
        hint: 'Enable bulk operations in project configuration'
      })
    }

    try {
      const schema = (req.query.schema as string) || 'public'

      if (req.method === 'POST') {
        await this.handleBulkInsert(req, res, tableName, schema)
      } else if (req.method === 'PATCH') {
        await this.handleBulkUpdate(req, res, tableName, schema)
      } else {
        return res.status(405).json({
          code: 'PGRST105',
          message: 'Method not allowed',
          details: 'Bulk operations only support POST (insert) and PATCH (update) methods',
          hint: 'Use POST for bulk inserts or PATCH for bulk updates'
        })
      }
    } catch (error) {
      console.error(`Bulk operation failed for ${tableName}:`, error)
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Bulk operation failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Check server logs for more details'
      })
    }
  }

  /**
   * Handle bulk insert operations
   * Requirements: 8.1, 8.3, 8.4, 8.5
   */
  private async handleBulkInsert(
    req: NextApiRequest,
    res: NextApiResponse,
    tableName: string,
    schema: string
  ): Promise<void> {
    try {
      if (!Array.isArray(req.body)) {
        return res.status(400).json({
          code: 'PGRST103',
          message: 'Invalid request body',
          details: 'Bulk insert requires an array of records',
          hint: 'Send an array of objects in the request body'
        })
      }

      // Parse bulk insert options from headers and query parameters
      const options: BulkInsertOptions = {
        schema,
        chunkSize: this.parseChunkSize(req.query.chunk_size as string),
        onConflict: this.parseOnConflict(req.headers['prefer'] as string),
        conflictColumns: this.parseConflictColumns(req.headers['prefer'] as string),
        returning: this.parseReturning(req.query.select as string),
        continueOnError: req.query.continue_on_error === 'true'
      }

      // Execute bulk insert
      const result = await this.bulkOperationService.executeBulkInsert(
        this.projectContext,
        tableName,
        req.body,
        options
      )

      // Set response headers
      res.setHeader('Content-Type', 'application/json')
      
      if (result.executionTime) {
        res.setHeader('X-Execution-Time', result.executionTime.toString())
      }

      // Add bulk operation metadata headers
      res.setHeader('X-Bulk-Operation', 'insert')
      res.setHeader('X-Total-Records', result.totalRecords.toString())
      res.setHeader('X-Inserted-Count', result.insertedCount.toString())
      res.setHeader('X-Failed-Count', result.failedCount.toString())
      res.setHeader('X-Total-Chunks', result.summary.totalChunks.toString())
      res.setHeader('X-Successful-Chunks', result.summary.successfulChunks.toString())

      if (result.failedCount > 0) {
        res.setHeader('X-Partial-Success', 'true')
      }

      // Return appropriate status code
      const statusCode = result.success ? 201 : 
                        result.insertedCount > 0 ? 207 : // Multi-status for partial success
                        400

      // Build response body
      const responseBody: any = {
        inserted: result.insertedCount,
        failed: result.failedCount,
        total: result.totalRecords,
        executionTime: result.executionTime,
        summary: result.summary
      }

      // Include failed records if any
      if (result.failedRecords.length > 0) {
        responseBody.errors = result.failedRecords.map(failed => ({
          index: failed.index,
          error: failed.error,
          record: failed.record
        }))
      }

      // Include returned data if requested
      if (options.returning && result.chunks.some(chunk => chunk.returnedData)) {
        responseBody.data = result.chunks
          .filter(chunk => chunk.returnedData)
          .flatMap(chunk => chunk.returnedData!)
      }

      res.status(statusCode).json(responseBody)
    } catch (error) {
      throw error // Re-throw to be handled by the main error handler
    }
  }

  /**
   * Handle bulk update operations
   * Requirements: 8.2, 8.3, 8.4, 8.5
   */
  private async handleBulkUpdate(
    req: NextApiRequest,
    res: NextApiResponse,
    tableName: string,
    schema: string
  ): Promise<void> {
    try {
      if (!Array.isArray(req.body)) {
        return res.status(400).json({
          code: 'PGRST103',
          message: 'Invalid request body',
          details: 'Bulk update requires an array of update operations',
          hint: 'Send an array of objects with "data" and "filters" properties'
        })
      }

      // Validate update operations format
      const updates: BulkUpdateOperation[] = []
      for (let i = 0; i < req.body.length; i++) {
        const item = req.body[i]
        
        if (!item || typeof item !== 'object') {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid update operation format',
            details: `Update operation at index ${i} must be an object`,
            hint: 'Each update operation must have "data" and "filters" properties'
          })
        }

        if (!item.data || typeof item.data !== 'object') {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid update operation format',
            details: `Update operation at index ${i} missing "data" property`,
            hint: 'Each update operation must have a "data" object with columns to update'
          })
        }

        if (!item.filters || !Array.isArray(item.filters)) {
          return res.status(400).json({
            code: 'PGRST103',
            message: 'Invalid update operation format',
            details: `Update operation at index ${i} missing "filters" property`,
            hint: 'Each update operation must have a "filters" array with WHERE conditions'
          })
        }

        updates.push({
          data: item.data,
          filters: item.filters
        })
      }

      // Parse bulk update options from headers and query parameters
      const options: BulkUpdateOptions = {
        schema,
        chunkSize: this.parseChunkSize(req.query.chunk_size as string),
        returning: this.parseReturning(req.query.select as string),
        continueOnError: req.query.continue_on_error === 'true'
      }

      // Execute bulk update
      const result = await this.bulkOperationService.executeBulkUpdate(
        this.projectContext,
        tableName,
        updates,
        options
      )

      // Set response headers
      res.setHeader('Content-Type', 'application/json')
      
      if (result.executionTime) {
        res.setHeader('X-Execution-Time', result.executionTime.toString())
      }

      // Add bulk operation metadata headers
      res.setHeader('X-Bulk-Operation', 'update')
      res.setHeader('X-Total-Operations', result.totalOperations.toString())
      res.setHeader('X-Updated-Count', result.updatedCount.toString())
      res.setHeader('X-Failed-Count', result.failedCount.toString())
      res.setHeader('X-Total-Chunks', result.summary.totalChunks.toString())
      res.setHeader('X-Successful-Chunks', result.summary.successfulChunks.toString())

      if (result.failedCount > 0) {
        res.setHeader('X-Partial-Success', 'true')
      }

      // Return appropriate status code
      const statusCode = result.success ? 200 : 
                        result.updatedCount > 0 ? 207 : // Multi-status for partial success
                        400

      // Build response body
      const responseBody: any = {
        updated: result.updatedCount,
        failed: result.failedCount,
        total: result.totalOperations,
        executionTime: result.executionTime,
        summary: result.summary
      }

      // Include failed updates if any
      if (result.failedUpdates.length > 0) {
        responseBody.errors = result.failedUpdates.map(failed => ({
          index: failed.index,
          error: failed.error,
          operation: failed.update
        }))
      }

      res.status(statusCode).json(responseBody)
    } catch (error) {
      throw error // Re-throw to be handled by the main error handler
    }
  }

  /**
   * Parse chunk size from query parameter
   * Requirements: 8.3
   */
  private parseChunkSize(chunkSizeParam?: string): number | undefined {
    if (!chunkSizeParam || typeof chunkSizeParam !== 'string') {
      return undefined
    }

    const chunkSize = parseInt(chunkSizeParam, 10)
    if (isNaN(chunkSize) || chunkSize < 1) {
      return undefined
    }

    // Get limits from service
    const limits = this.bulkOperationService.getBulkOperationLimits()
    return Math.min(chunkSize, limits.maxChunkSize)
  }

  /**
   * Parse on conflict strategy from Prefer header
   * Requirements: 8.1
   */
  private parseOnConflict(preferHeader?: string): 'ignore' | 'update' | undefined {
    if (!preferHeader || typeof preferHeader !== 'string') {
      return undefined
    }

    if (preferHeader.includes('resolution=ignore')) {
      return 'ignore'
    }

    if (preferHeader.includes('resolution=merge-duplicates')) {
      return 'update'
    }

    return undefined
  }

  /**
   * Parse conflict columns from Prefer header
   * Requirements: 8.1
   */
  private parseConflictColumns(preferHeader?: string): string[] | undefined {
    if (!preferHeader || typeof preferHeader !== 'string') {
      return undefined
    }

    const match = preferHeader.match(/on-conflict=([^,;]+)/)
    if (match) {
      return match[1].split(',').map(col => col.trim())
    }

    return undefined
  }

  /**
   * Parse returning columns from select parameter
   * Requirements: 8.5
   */
  private parseReturning(selectParam?: string): string[] | '*' | undefined {
    if (!selectParam || typeof selectParam !== 'string') {
      return undefined
    }

    if (selectParam === '*') {
      return '*'
    }

    return selectParam.split(',').map(col => col.trim()).filter(col => col.length > 0)
  }

  /**
   * Check if a resource path refers to a database view
   * Requirements: 2.1
   */
  private async isViewAccess(resourcePath: string): Promise<boolean> {
    // Skip if it's clearly not a view
    if (resourcePath.includes('/') || 
        resourcePath.startsWith('rpc/') || 
        resourcePath.length === 0 ||
        resourcePath === 'functions') {
      return false
    }

    try {
      // Check if the resource is a view in the database
      const schema = 'public' // Could be extracted from query params if needed
      return await this.viewService.isView(this.projectContext, resourcePath, schema)
    } catch (error) {
      console.error(`Error checking if ${resourcePath} is a view:`, error)
      return false
    }
  }

  /**
   * Check if the request requires enhanced features
   * Requirements: 1.1, 2.1, 3.1, 3.2, 3.3, 3.4, 3.5
   */
  private requiresEnhancedFeatures(req: NextApiRequest): boolean {
    const query = req.query
    
    // Check for advanced filtering operators
    const hasAdvancedFilters = Object.keys(query).some(key => {
      const parts = key.split('.')
      if (parts.length >= 2) {
        const operator = parts[1]
        return ['in', 'is', 'not', 'gte', 'lte', 'gt', 'lt', 'like', 'ilike'].includes(operator)
      }
      return false
    })
    
    // Check for logical operators
    const hasLogicalOperators = Boolean(query.and || query.or)
    
    // Check for advanced JSON operators
    const hasJSONOperators = Object.keys(query).some(key => {
      const parts = key.split('.')
      if (parts.length >= 2) {
        const operator = parts[1]
        return ['->', '->>', '@>', '<@', '?', '?&', '?|'].includes(operator)
      }
      return false
    })
    
    // Check for full-text search operators
    const hasFTSOperators = Object.keys(query).some(key => 
      key.includes('.fts') || key.includes('.plfts') || key.includes('.phfts') || key.includes('.wfts')
    )
    
    // Check for aggregate functions in select
    const selectParam = query.select as string
    const hasAggregates = selectParam && (
      selectParam.includes('count(') || 
      selectParam.includes('sum(') || 
      selectParam.includes('avg(') || 
      selectParam.includes('min(') || 
      selectParam.includes('max(')
    )
    
    // Check for array operators
    const hasArrayOperators = Object.keys(query).some(key => {
      const parts = key.split('.')
      if (parts.length >= 2) {
        const operator = parts[1]
        // Check for array operators: cs (contains), cd (contained), ov (overlap)
        if (['cs', 'cd', 'ov'].includes(operator)) {
          return true
        }
        // Check for array indexing (numeric index)
        if (/^\d+$/.test(operator)) {
          return true
        }
        // Check for array length
        if (operator === 'length') {
          return true
        }
      }
      return false
    })
    
    // Check for bulk operations (array body)
    const isBulkOperation = req.method === 'POST' && Array.isArray(req.body)
    
    // Check for nested resource queries
    const hasNestedQueries = selectParam && selectParam.includes('(')
    
    // Check for transaction headers
    const preferHeader = req.headers['prefer']
    const hasTransactionHeaders = Boolean(preferHeader && preferHeader.includes('tx=')) || 
                                  Boolean(req.headers['x-supabase-tx'])
    
    // Check for content negotiation
    const acceptHeader = req.headers.accept
    const hasContentNegotiation = Boolean(acceptHeader && (
      acceptHeader.includes('text/csv') || 
      acceptHeader.includes('application/vnd.pgrst.object+json')
    ))

    // JSON operations and full-text search are handled locally, not proxied to container
    return hasAdvancedFilters ||
           hasLogicalOperators ||
           hasAggregates || 
           hasArrayOperators || 
           isBulkOperation || 
           hasNestedQueries || 
           hasTransactionHeaders || 
           hasContentNegotiation
  }

  /**
   * Get the current context (helper method)
   */
  private getContext(): ProjectIsolationContext {
    return this.projectContext
  }

  /**
   * Get health status for the enhanced engine
   * Requirements: 13.1
   */
  async getHealthStatus(): Promise<{ healthy: boolean; details: Record<string, any> }> {
    try {
      if (!this.enhancedConfig) {
        return {
          healthy: false,
          details: { error: 'Enhanced configuration not initialized' }
        }
      }

      // Get health status from container
      const containerHealth = await this.containerClient.getContainerHealth(this.enhancedConfig.projectRef)
      
      // Get configuration manager health
      const configManager = getEnhancedPostgRESTConfigManager()
      const projectHealth = configManager.getProjectHealthStatus(this.enhancedConfig.projectRef)
      
      return {
        healthy: containerHealth.healthy && (projectHealth?.status === 'healthy' || false),
        details: {
          container: containerHealth,
          project: projectHealth,
          features: {
            rpcFunctions: this.enhancedConfig.enableRPCFunctions,
            databaseViews: this.enhancedConfig.enableDatabaseViews,
            advancedJSON: this.enhancedConfig.enableAdvancedJSON,
            fullTextSearch: this.enhancedConfig.enableFullTextSearch,
            aggregateQueries: this.enhancedConfig.enableAggregateQueries,
            bulkOperations: this.enhancedConfig.enableBulkOperations,
            nestedResources: this.enhancedConfig.enableNestedResources,
            transactions: this.enhancedConfig.enableTransactions,
            arrayOperations: this.enhancedConfig.enableArrayOperations,
            contentNegotiation: this.enhancedConfig.enableContentNegotiation
          }
        }
      }
    } catch (error) {
      return {
        healthy: false,
        details: { error: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  }

  /**
   * Get performance metrics for the enhanced engine
   * Requirements: 13.1
   */
  async getPerformanceMetrics(): Promise<Record<string, any>> {
    try {
      if (!this.enhancedConfig) {
        return { error: 'Enhanced configuration not initialized' }
      }

      // Get metrics from container
      const containerMetrics = await this.containerClient.getContainerMetrics(this.enhancedConfig.projectRef)
      
      return {
        projectRef: this.enhancedConfig.projectRef,
        container: containerMetrics,
        configuration: {
          queryTimeout: this.enhancedConfig.queryTimeout,
          connectionPoolSize: this.enhancedConfig.connectionPoolSize,
          enableQueryLogging: this.enhancedConfig.enableQueryLogging,
          enablePerformanceMonitoring: this.enhancedConfig.enablePerformanceMonitoring,
          enableCaching: this.enhancedConfig.enableCaching
        }
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown error' }
    }
  }

  /**
   * Check if request contains nested resource queries
   * Requirements: 9.1
   */
  private hasNestedResourceQueries(req: NextApiRequest): boolean {
    const selectParam = req.query.select as string
    return Boolean(selectParam && selectParam.includes('('))
  }

  /**
   * Handle nested resource queries
   * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
   */
  private async handleNestedResourceQuery(req: NextApiRequest, res: NextApiResponse, tableName: string): Promise<void> {
    if (!this.enhancedConfig?.enableNestedResources) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'Nested resources not enabled',
        details: 'Nested resource support is disabled for this project',
        hint: 'Enable nested resources in project configuration'
      })
    }

    try {
      const schema = (req.query.schema as string) || 'public'
      const selectParam = req.query.select as string

      if (!selectParam) {
        // No select parameter, fall back to regular handling
        await this.handleRequest(req, res, tableName)
        return
      }

      // Parse nested resource queries
      const nestedQueries = this.nestedResourceService.parseNestedSelection(selectParam)
      
      if (nestedQueries.length === 0) {
        // No nested queries found, fall back to regular handling
        await this.handleRequest(req, res, tableName)
        return
      }

      // First, execute the base query to get the main data
      const baseData = await this.executeBaseQuery(req, tableName, schema)
      
      if (baseData.length === 0) {
        // No base data, return empty result
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Range', '0-0/0')
        return res.status(200).json([])
      }

      // Execute nested resource queries
      const nestedResult = await this.nestedResourceService.executeNestedQuery(
        this.projectContext,
        tableName,
        baseData,
        nestedQueries,
        schema
      )

      if (!nestedResult.success) {
        return res.status(400).json({
          code: nestedResult.code || 'PGRST000',
          message: 'Nested resource query failed',
          details: nestedResult.error,
          hint: 'Check your nested resource syntax and permissions'
        })
      }

      // Apply content negotiation for nested resources
      const acceptHeader = req.headers.accept
      const negotiationResult = this.contentNegotiationService.negotiateContentType(acceptHeader)
      
      if (!negotiationResult.isSupported) {
        const error = this.contentNegotiationService.createUnsupportedFormatError(acceptHeader || '')
        return res.status(error.statusCode).json({
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        })
      }

      // Apply format-specific optimizations
      const optimizationResult = this.contentNegotiationService.applyFormatOptimizations(
        nestedResult.data || [],
        negotiationResult.format!
      )

      // Format the response
      const formatResult = this.contentNegotiationService.formatResponse(
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
      this.contentNegotiationService.setResponseHeaders(
        res,
        negotiationResult.format!,
        negotiationResult.contentType!,
        typeof formatResult.data === 'string' ? formatResult.data.length : undefined
      )
      
      // Add pagination headers
      const paginationHeaders = this.responseShapingService.generatePaginationHeaders(
        nestedResult.data || [],
        undefined, // totalCount not available for nested queries
        this.parseLimit(req.query.limit as string),
        this.parseOffset(req.query.offset as string)
      )
      
      Object.entries(paginationHeaders).forEach(([key, value]) => {
        res.setHeader(key, value)
      })

      // Add nested resource metadata headers
      res.setHeader('X-Nested-Resources', 'true')
      res.setHeader('X-Nested-Relations', nestedQueries.map(nq => nq.relation).join(','))
      res.setHeader('X-Response-Format', negotiationResult.format!)
      res.setHeader('X-Applied-Optimizations', optimizationResult.appliedOptimizations.join(','))
      
      if (nestedResult.relationships) {
        res.setHeader('X-Relationship-Count', nestedResult.relationships.length.toString())
      }

      // Return the formatted data
      if (negotiationResult.format === 'csv') {
        res.status(200).send(formatResult.data)
      } else {
        res.status(200).json(formatResult.data)
      }
    } catch (error) {
      console.error(`Nested resource query failed for ${tableName}:`, error)
      
      res.status(500).json({
        code: 'PGRST000',
        message: 'Nested resource query failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        hint: 'Check server logs for more details'
      })
    }
  }

  /**
   * Execute base query for nested resource queries
   * Requirements: 9.1, 9.2
   */
  private async executeBaseQuery(req: NextApiRequest, tableName: string, schema: string): Promise<any[]> {
    try {
      const projectDbClient = getProjectDatabaseClient()
      
      // Build base query with filters but without nested selections
      const whereResult = this.buildWhereClause(req.query)
      const orderClause = this.buildOrderClause(req.query.order as string)
      const limitClause = this.buildLimitClause(
        this.parseLimit(req.query.limit as string),
        this.parseOffset(req.query.offset as string)
      )

      // Get base columns (excluding nested selections)
      const baseColumns = this.extractBaseColumns(req.query.select as string)
      
      console.log(`[executeBaseQuery] Initial base columns:`, baseColumns)
      
      // Extract nested queries to determine required foreign key columns
      const nestedQueries = this.nestedResourceService.parseNestedSelection(req.query.select as string || '')
      const requiredForeignKeys: string[] = []
      
      console.log(`[executeBaseQuery] Found ${nestedQueries.length} nested queries`)
      
      if (nestedQueries.length > 0) {
        // Get relationships to find foreign key columns
        const relationships = await this.nestedResourceService['getTableRelationships'](
          this.projectContext,
          tableName,
          schema
        )
        
        console.log(`[executeBaseQuery] Found ${relationships.length} relationships`)
        
        for (const nestedQuery of nestedQueries) {
          const relationship = relationships.find(rel => 
            rel.relationName === nestedQuery.relation ||
            rel.targetTable === nestedQuery.relation
          )
          
          console.log(`[executeBaseQuery] Nested query '${nestedQuery.relation}' relationship:`, relationship)
          
          if (relationship && relationship.relationshipType === 'outbound') {
            // For outbound relationships, we need the source column (foreign key)
            const fkColumn = `"${relationship.sourceColumn}"`
            if (!baseColumns.includes(fkColumn) && !requiredForeignKeys.includes(fkColumn)) {
              requiredForeignKeys.push(fkColumn)
              console.log(`[executeBaseQuery] Added required FK column: ${fkColumn}`)
            }
          }
        }
      }
      
      // Combine base columns with required foreign keys
      const allColumns = [...baseColumns, ...requiredForeignKeys]
      const selectClause = allColumns.length > 0 ? allColumns.join(', ') : '*'

      console.log(`[executeBaseQuery] Final select clause: ${selectClause}`)

      const query = `
        SELECT ${selectClause}
        FROM "${schema}"."${tableName}"
        ${whereResult.clause ? `WHERE ${whereResult.clause}` : ''}
        ${orderClause}
        ${limitClause}
      `

      const result = await projectDbClient.queryProjectDatabase(
        this.projectContext.projectRef,
        this.projectContext.userId,
        query,
        whereResult.params,
        { skipPermissionCheck: true }
      )

      console.log(`[executeBaseQuery] Query returned ${result.rows.length} rows, sample:`, result.rows[0])

      return result.rows
    } catch (error) {
      console.error(`Base query failed for ${tableName}:`, error)
      throw error
    }
  }

  /**
   * Extract base columns from select parameter (excluding nested selections)
   */
  private extractBaseColumns(selectParam?: string): string[] {
    if (!selectParam) {
      return []
    }

    const parts = this.parseSelectParts(selectParam)
    const baseColumns: string[] = []

    for (const part of parts) {
      if (!part.includes('(')) {
        // This is a base column, not a nested selection
        const trimmed = part.trim()
        // Don't quote * wildcard
        baseColumns.push(trimmed === '*' ? '*' : `"${trimmed}"`)
      }
    }

    return baseColumns
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
   * Check if request has transaction headers
   * Requirements: 10.1
   */
  private hasTransactionHeaders(req: NextApiRequest): boolean {
    const preferHeader = req.headers['prefer'] as string
    const transactionHeader = req.headers['x-supabase-tx'] as string
    
    return Boolean(preferHeader && preferHeader.includes('tx=')) || 
           Boolean(transactionHeader)
  }

  /**
   * Handle transactional request
   * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
   */
  private async handleTransactionalRequest(
    req: NextApiRequest,
    res: NextApiResponse,
    resourcePath: string
  ): Promise<void> {
    if (!this.enhancedConfig?.enableTransactions) {
      return res.status(501).json({
        code: 'PGRST000',
        message: 'Transaction support is not enabled',
        hint: 'Enable transaction support in project configuration'
      })
    }

    const context = this.getContext()
    const preferHeader = req.headers['prefer'] as string
    const transactionHeader = req.headers['x-supabase-tx'] as string

    // Declare transactionId outside try block so it's accessible in catch
    let transactionId: string | null = null

    try {
      // Parse transaction directive from Prefer header
      let transactionAction: string | null = null
      let isolationLevel: string | undefined

      if (preferHeader && preferHeader.includes('tx=')) {
        const txMatch = preferHeader.match(/tx=([^,;]+)/)
        if (txMatch) {
          transactionAction = txMatch[1].trim()
        }
      }

      if (transactionHeader) {
        transactionId = transactionHeader
      }

      // Handle different transaction actions
      switch (transactionAction) {
        case 'begin':
          await this.handleTransactionBegin(req, res, isolationLevel)
          return

        case 'commit':
          if (!transactionId) {
            return res.status(400).json({
              code: 'PGRST100',
              message: 'Transaction ID required for commit',
              hint: 'Include X-Supabase-Tx header with transaction ID'
            })
          }
          await this.handleTransactionCommit(req, res, transactionId)
          return

        case 'rollback':
          if (!transactionId) {
            return res.status(400).json({
              code: 'PGRST100',
              message: 'Transaction ID required for rollback',
              hint: 'Include X-Supabase-Tx header with transaction ID'
            })
          }
          await this.handleTransactionRollback(req, res, transactionId)
          return

        default:
          // Execute operation within existing transaction
          if (transactionId) {
            await this.handleTransactionOperation(req, res, resourcePath, transactionId)
            return
          }

          // Auto-transaction mode: wrap single operation in transaction
          await this.handleAutoTransaction(req, res, resourcePath)
          return
      }
    } catch (error) {
      console.error('Transaction handling error:', error)
      
      // Handle deadlock errors
      if (transactionId && this.isDeadlockError(error)) {
        await this.transactionService.handleDeadlock(transactionId, error)
        return res.status(409).json({
          code: 'PGRST409',
          message: 'Transaction deadlock detected',
          details: error instanceof Error ? error.message : 'Unknown error',
          hint: 'Retry the transaction'
        })
      }

      res.status(500).json({
        code: 'PGRST000',
        message: 'Transaction error',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Handle transaction begin
   * Requirements: 10.1, 10.2
   */
  private async handleTransactionBegin(
    req: NextApiRequest,
    res: NextApiResponse,
    isolationLevel?: string
  ): Promise<void> {
    const context = this.getContext()
    
    try {
      // Parse timeout from query parameters
      const timeout = req.query.timeout ? parseInt(req.query.timeout as string, 10) : undefined
      
      // Begin transaction
      const transactionContext = await this.transactionService.beginTransaction(
        context.projectRef,
        context.userId,
        {
          timeout,
          isolationLevel: isolationLevel as any
        }
      )

      res.status(201).json({
        transaction_id: transactionContext.id,
        status: 'active',
        timeout: transactionContext.timeout,
        isolation_level: transactionContext.isolationLevel,
        started_at: transactionContext.startTime.toISOString()
      })
    } catch (error) {
      res.status(500).json({
        code: 'PGRST000',
        message: 'Failed to begin transaction',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Handle transaction commit
   * Requirements: 10.2, 10.3
   */
  private async handleTransactionCommit(
    req: NextApiRequest,
    res: NextApiResponse,
    transactionId: string
  ): Promise<void> {
    try {
      const result = await this.transactionService.commitTransaction(transactionId)
      
      res.status(200).json({
        transaction_id: result.transactionId,
        status: result.status,
        operation_count: result.operationCount,
        execution_time: result.executionTime,
        committed_at: result.endTime.toISOString()
      })
    } catch (error) {
      res.status(500).json({
        code: 'PGRST000',
        message: 'Failed to commit transaction',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Handle transaction rollback
   * Requirements: 10.2, 10.3
   */
  private async handleTransactionRollback(
    req: NextApiRequest,
    res: NextApiResponse,
    transactionId: string
  ): Promise<void> {
    try {
      const result = await this.transactionService.rollbackTransaction(transactionId)
      
      res.status(200).json({
        transaction_id: result.transactionId,
        status: result.status,
        operation_count: result.operationCount,
        execution_time: result.executionTime,
        rolled_back_at: result.endTime.toISOString(),
        error: result.error
      })
    } catch (error) {
      res.status(500).json({
        code: 'PGRST000',
        message: 'Failed to rollback transaction',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Handle operation within transaction
   * Requirements: 10.1, 10.2
   */
  private async handleTransactionOperation(
    req: NextApiRequest,
    res: NextApiResponse,
    resourcePath: string,
    transactionId: string
  ): Promise<void> {
    try {
      // Get transaction status
      const status = this.transactionService.getTransactionStatus(transactionId)
      if (!status) {
        return res.status(404).json({
          code: 'PGRST404',
          message: 'Transaction not found',
          hint: 'Verify the transaction ID is correct'
        })
      }

      if (status.status !== 'active') {
        return res.status(409).json({
          code: 'PGRST409',
          message: `Transaction is not active (status: ${status.status})`,
          hint: 'Only active transactions can execute operations'
        })
      }

      // Build database operation from request
      const operation = await this.buildDatabaseOperation(req, resourcePath)
      
      // Execute operation within transaction
      const result = await this.transactionService.executeInTransaction(transactionId, operation)
      
      // Format and return response
      await this.formatTransactionOperationResponse(req, res, result, operation)
      
    } catch (error) {
      // Handle deadlock errors
      if (this.isDeadlockError(error)) {
        await this.transactionService.handleDeadlock(transactionId, error)
        return res.status(409).json({
          code: 'PGRST409',
          message: 'Transaction deadlock detected',
          details: error instanceof Error ? error.message : 'Unknown error',
          hint: 'Retry the transaction'
        })
      }

      res.status(500).json({
        code: 'PGRST000',
        message: 'Transaction operation failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Handle auto-transaction (wrap single operation in transaction)
   * Requirements: 10.1, 10.2, 10.3
   */
  private async handleAutoTransaction(
    req: NextApiRequest,
    res: NextApiResponse,
    resourcePath: string
  ): Promise<void> {
    const context = this.getContext()
    let transactionContext: TransactionContext | null = null

    try {
      // Begin auto-transaction
      transactionContext = await this.transactionService.beginTransaction(
        context.projectRef,
        context.userId,
        { timeout: 30000 } // 30 second timeout for auto-transactions
      )

      // Build and execute operation
      const operation = await this.buildDatabaseOperation(req, resourcePath)
      const result = await this.transactionService.executeInTransaction(transactionContext.id, operation)

      // Auto-commit
      await this.transactionService.commitTransaction(transactionContext.id)

      // Format and return response
      await this.formatTransactionOperationResponse(req, res, result, operation)

    } catch (error) {
      // Auto-rollback on error
      if (transactionContext) {
        try {
          await this.transactionService.rollbackTransaction(transactionContext.id)
        } catch (rollbackError) {
          console.error('Auto-rollback failed:', rollbackError)
        }
      }

      res.status(500).json({
        code: 'PGRST000',
        message: 'Auto-transaction failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  /**
   * Build database operation from request
   * Requirements: 10.1, 10.2
   */
  private async buildDatabaseOperation(req: NextApiRequest, resourcePath: string): Promise<DatabaseOperation> {
    const method = req.method?.toUpperCase()
    const tableName = resourcePath.split('/')[0]

    switch (method) {
      case 'GET':
        return {
          type: 'select',
          sql: await this.buildSelectSQL(req, resourcePath),
          table: tableName
        }

      case 'POST':
        if (resourcePath.startsWith('rpc/')) {
          const functionName = resourcePath.substring(4)
          return {
            type: 'rpc',
            sql: await this.buildRPCSQL(functionName, req.body),
            function: functionName
          }
        } else {
          return {
            type: 'insert',
            sql: await this.buildInsertSQL(req, resourcePath),
            table: tableName
          }
        }

      case 'PATCH':
        return {
          type: 'update',
          sql: await this.buildUpdateSQL(req, resourcePath),
          table: tableName
        }

      case 'DELETE':
        return {
          type: 'delete',
          sql: await this.buildDeleteSQL(req, resourcePath),
          table: tableName
        }

      default:
        throw new Error(`Unsupported method for transaction: ${method}`)
    }
  }

  /**
   * Format transaction operation response
   * Requirements: 10.1, 10.2
   */
  private async formatTransactionOperationResponse(
    req: NextApiRequest,
    res: NextApiResponse,
    result: any,
    operation: DatabaseOperation
  ): Promise<void> {
    // Set appropriate headers
    res.setHeader('Content-Type', 'application/json')
    
    // Handle different operation types
    switch (operation.type) {
      case 'select':
        res.status(200).json(result.rows || [])
        break

      case 'insert':
        res.status(201).json(result.rows || [])
        break

      case 'update':
      case 'delete':
        res.status(200).json(result.rows || [])
        break

      case 'rpc':
        const rpcResult = result.rows?.[0]
        if (rpcResult && Object.keys(rpcResult).length === 1) {
          // Single column result - return the value directly
          const value = Object.values(rpcResult)[0]
          res.status(200).json(value)
        } else {
          res.status(200).json(result.rows || [])
        }
        break

      default:
        res.status(200).json(result.rows || [])
    }
  }

  /**
   * Build SELECT SQL for transaction
   */
  private async buildSelectSQL(req: NextApiRequest, resourcePath: string): Promise<string> {
    // This is a simplified implementation - in practice, you'd want to use
    // the existing query building logic from the base PostgREST engine
    const tableName = resourcePath.split('/')[0]
    const selectParam = req.query.select as string
    const whereConditions = this.buildWhereConditions(req.query)
    
    let sql = `SELECT ${selectParam || '*'} FROM ${tableName}`
    
    if (whereConditions) {
      sql += ` WHERE ${whereConditions}`
    }
    
    return sql
  }

  /**
   * Build INSERT SQL for transaction
   */
  private async buildInsertSQL(req: NextApiRequest, resourcePath: string): Promise<string> {
    const tableName = resourcePath.split('/')[0]
    const data = req.body
    
    if (Array.isArray(data)) {
      // Bulk insert
      const columns = Object.keys(data[0])
      const values = data.map(row => 
        `(${columns.map(col => `'${row[col]}'`).join(', ')})`
      ).join(', ')
      
      return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${values} RETURNING *`
    } else {
      // Single insert
      const columns = Object.keys(data)
      const values = columns.map(col => `'${data[col]}'`).join(', ')
      
      return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values}) RETURNING *`
    }
  }

  /**
   * Build UPDATE SQL for transaction
   */
  private async buildUpdateSQL(req: NextApiRequest, resourcePath: string): Promise<string> {
    const tableName = resourcePath.split('/')[0]
    const data = req.body
    const whereConditions = this.buildWhereConditions(req.query)
    
    const setClause = Object.keys(data)
      .map(col => `${col} = '${data[col]}'`)
      .join(', ')
    
    let sql = `UPDATE ${tableName} SET ${setClause}`
    
    if (whereConditions) {
      sql += ` WHERE ${whereConditions}`
    }
    
    sql += ' RETURNING *'
    
    return sql
  }

  /**
   * Build DELETE SQL for transaction
   */
  private async buildDeleteSQL(req: NextApiRequest, resourcePath: string): Promise<string> {
    const tableName = resourcePath.split('/')[0]
    const whereConditions = this.buildWhereConditions(req.query)
    
    let sql = `DELETE FROM ${tableName}`
    
    if (whereConditions) {
      sql += ` WHERE ${whereConditions}`
    }
    
    sql += ' RETURNING *'
    
    return sql
  }

  /**
   * Build RPC SQL for transaction
   */
  private async buildRPCSQL(functionName: string, params: any): Promise<string> {
    if (!params || Object.keys(params).length === 0) {
      return `SELECT ${functionName}()`
    }
    
    const paramValues = Object.values(params)
      .map(value => `'${value}'`)
      .join(', ')
    
    return `SELECT ${functionName}(${paramValues})`
  }

  /**
   * Build WHERE conditions from query parameters
   */
  private buildWhereConditions(query: any): string | null {
    const conditions: string[] = []
    
    for (const [key, value] of Object.entries(query)) {
      if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') {
        continue
      }
      
      if (typeof value === 'string') {
        if (value.startsWith('eq.')) {
          conditions.push(`${key} = '${value.substring(3)}'`)
        } else if (value.startsWith('neq.')) {
          conditions.push(`${key} != '${value.substring(4)}'`)
        } else if (value.startsWith('gt.')) {
          conditions.push(`${key} > '${value.substring(3)}'`)
        } else if (value.startsWith('gte.')) {
          conditions.push(`${key} >= '${value.substring(4)}'`)
        } else if (value.startsWith('lt.')) {
          conditions.push(`${key} < '${value.substring(3)}'`)
        } else if (value.startsWith('lte.')) {
          conditions.push(`${key} <= '${value.substring(4)}'`)
        } else {
          conditions.push(`${key} = '${value}'`)
        }
      }
    }
    
    return conditions.length > 0 ? conditions.join(' AND ') : null
  }

  /**
   * Check if error is a deadlock error
   * Requirements: 10.5
   */
  private isDeadlockError(error: any): boolean {
    if (!error) return false
    
    const errorMessage = error.message || error.toString()
    const errorCode = error.code

    // PostgreSQL deadlock error codes and messages
    return errorCode === '40P01' || // deadlock_detected
           errorCode === '40001' || // serialization_failure
           errorMessage.toLowerCase().includes('deadlock') ||
           errorMessage.toLowerCase().includes('could not serialize access')
  }
}

/**
 * Factory function to create an enhanced project PostgREST engine
 */
export function createEnhancedProjectPostgRESTEngine(
  context: ProjectIsolationContext,
  config: DataApiConfigResponse
): EnhancedProjectPostgRESTEngine {
  return new EnhancedProjectPostgRESTEngine(context, config)
}