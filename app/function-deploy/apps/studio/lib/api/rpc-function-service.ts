import { getProjectDatabaseClient } from './project-database-client'
import { ProjectIsolationContext } from './secure-api-wrapper'

/**
 * RPC Function Service
 * Handles PostgreSQL function discovery, validation, and execution
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */
export class RPCFunctionService {
  private static instance: RPCFunctionService
  private functionCache = new Map<string, DatabaseFunction[]>()
  private cacheExpiry = new Map<string, number>()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  private constructor() {}

  static getInstance(): RPCFunctionService {
    if (!RPCFunctionService.instance) {
      RPCFunctionService.instance = new RPCFunctionService()
    }
    return RPCFunctionService.instance
  }

  /**
   * Discover PostgreSQL functions in the specified schema
   * Requirements: 1.1
   */
  async discoverFunctions(
    context: ProjectIsolationContext,
    schema: string = 'public'
  ): Promise<DatabaseFunction[]> {
    const cacheKey = `${context.projectRef}:${schema}`
    
    // Check cache first
    if (this.isCacheValid(cacheKey)) {
      const cached = this.functionCache.get(cacheKey)
      if (cached) {
        return cached
      }
    }

    try {
      const projectDbClient = getProjectDatabaseClient()
      
      // Query to discover functions with their parameters and return types
      const query = `
        SELECT 
          p.proname as function_name,
          n.nspname as schema_name,
          pg_get_function_result(p.oid) as return_type,
          pg_get_function_arguments(p.oid) as arguments,
          p.proretset as is_set_returning,
          obj_description(p.oid, 'pg_proc') as description,
          p.pronargs as num_args,
          COALESCE(
            array_agg(
              CASE 
                WHEN t.typname IS NOT NULL THEN t.typname
                ELSE 'unknown'
              END
              ORDER BY generate_series(1, p.pronargs)
            ) FILTER (WHERE generate_series(1, p.pronargs) <= p.pronargs),
            ARRAY[]::text[]
          ) as param_types,
          COALESCE(
            array_agg(
              CASE 
                WHEN pa.parameter_name IS NOT NULL THEN pa.parameter_name
                ELSE 'param_' || generate_series(1, p.pronargs)
              END
              ORDER BY pa.ordinal_position
            ) FILTER (WHERE pa.ordinal_position IS NOT NULL),
            ARRAY[]::text[]
          ) as param_names,
          COALESCE(
            array_agg(
              CASE 
                WHEN pa.parameter_default IS NOT NULL THEN true
                ELSE false
              END
              ORDER BY pa.ordinal_position
            ) FILTER (WHERE pa.ordinal_position IS NOT NULL),
            ARRAY[]::boolean[]
          ) as param_has_defaults
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        LEFT JOIN pg_type t ON t.oid = ANY(p.proargtypes)
        LEFT JOIN information_schema.parameters pa ON (
          pa.specific_schema = n.nspname 
          AND pa.specific_name = p.proname || '_' || p.oid
        )
        WHERE n.nspname = $1
          AND p.prokind = 'f'  -- Only functions, not procedures
          AND has_function_privilege(p.oid, 'EXECUTE')
        GROUP BY p.oid, p.proname, n.nspname, p.proretset, p.pronargs
        ORDER BY p.proname
      `

      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query,
        [schema],
        { skipPermissionCheck: true }
      )

      const functions: DatabaseFunction[] = result.rows.map(row => {
        // Parse parameters from the arguments string
        const parameters = this.parseParameters(
          row.arguments || '',
          row.param_names || [],
          row.param_types || [],
          row.param_has_defaults || []
        )

        return {
          name: row.function_name,
          schema: row.schema_name,
          parameters,
          returnType: row.return_type || 'void',
          isSetReturning: row.is_set_returning || false,
          description: row.description || undefined
        }
      })

      // Cache the results
      this.functionCache.set(cacheKey, functions)
      this.cacheExpiry.set(cacheKey, Date.now() + this.CACHE_TTL)

      return functions
    } catch (error) {
      console.error(`Failed to discover functions in schema ${schema}:`, error)
      throw new Error(`Function discovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Validate a function call with parameters
   * Requirements: 1.2
   */
  async validateFunctionCall(
    context: ProjectIsolationContext,
    functionName: string,
    parameters: any[],
    schema: string = 'public'
  ): Promise<ValidationResult> {
    try {
      const functions = await this.discoverFunctions(context, schema)
      const targetFunction = functions.find(f => f.name === functionName)

      if (!targetFunction) {
        return {
          isValid: false,
          error: `Function "${functionName}" does not exist in schema "${schema}"`,
          code: 'PGRST202'
        }
      }

      // Check parameter count
      const requiredParams = targetFunction.parameters.filter(p => p.isRequired)
      const providedParamCount = parameters.length

      if (providedParamCount < requiredParams.length) {
        return {
          isValid: false,
          error: `Function "${functionName}" requires at least ${requiredParams.length} parameters, but ${providedParamCount} were provided`,
          code: 'PGRST103'
        }
      }

      if (providedParamCount > targetFunction.parameters.length) {
        return {
          isValid: false,
          error: `Function "${functionName}" accepts at most ${targetFunction.parameters.length} parameters, but ${providedParamCount} were provided`,
          code: 'PGRST103'
        }
      }

      // Validate parameter types (basic validation)
      for (let i = 0; i < providedParamCount; i++) {
        const param = targetFunction.parameters[i]
        const value = parameters[i]
        
        const typeValidation = this.validateParameterType(param.type, value)
        if (!typeValidation.isValid) {
          return {
            isValid: false,
            error: `Parameter "${param.name}" (position ${i + 1}): ${typeValidation.error}`,
            code: 'PGRST103'
          }
        }
      }

      return {
        isValid: true,
        function: targetFunction
      }
    } catch (error) {
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Unknown validation error',
        code: 'PGRST000'
      }
    }
  }

  /**
   * Execute a PostgreSQL function call
   * Requirements: 1.1, 1.2, 1.3
   */
  async executeFunctionCall(
    context: ProjectIsolationContext,
    functionName: string,
    parameters: any[],
    schema: string = 'public'
  ): Promise<FunctionResult> {
    const startTime = Date.now()

    try {
      // Validate the function call first
      const validation = await this.validateFunctionCall(context, functionName, parameters, schema)
      if (!validation.isValid) {
        throw new Error(validation.error)
      }

      const targetFunction = validation.function!
      const projectDbClient = getProjectDatabaseClient()

      // Build the function call SQL
      const schemaPrefix = schema !== 'public' ? `"${schema}".` : ''
      const paramPlaceholders = parameters.map((_, index) => `$${index + 1}`).join(', ')
      
      let query: string
      if (targetFunction.isSetReturning) {
        // For set-returning functions, use SELECT * FROM
        query = `SELECT * FROM ${schemaPrefix}"${functionName}"(${paramPlaceholders})`
      } else {
        // For scalar functions, use SELECT
        query = `SELECT ${schemaPrefix}"${functionName}"(${paramPlaceholders}) as result`
      }

      // Execute the function
      const result = await projectDbClient.queryProjectDatabase(
        context.projectRef,
        context.userId,
        query,
        parameters,
        { skipPermissionCheck: true }
      )

      const executionTime = Date.now() - startTime

      return {
        success: true,
        data: targetFunction.isSetReturning ? result.rows : result.rows[0],
        returnType: targetFunction.returnType,
        executionTime,
        rowCount: result.rows.length
      }
    } catch (error) {
      const executionTime = Date.now() - startTime
      
      console.error(`Function execution failed for ${functionName}:`, error)
      
      return {
        success: false,
        data: null,
        returnType: 'unknown',
        executionTime,
        error: error instanceof Error ? error.message : 'Unknown execution error',
        rowCount: 0
      }
    }
  }

  /**
   * Format function response for HTTP response
   * Requirements: 1.3, 1.4
   */
  formatFunctionResponse(result: FunctionResult): any {
    if (!result.success) {
      return {
        error: result.error,
        code: 'PGRST000',
        message: 'Function execution failed',
        details: result.error
      }
    }

    // For set-returning functions, return the array of rows
    if (Array.isArray(result.data)) {
      return result.data
    }

    // For scalar functions, return the result value
    if (result.data && typeof result.data === 'object' && 'result' in result.data) {
      return result.data.result
    }

    // Return the data as-is
    return result.data
  }

  /**
   * Clear function cache for a project
   * Requirements: 1.1
   */
  clearCache(projectRef: string, schema?: string): void {
    if (schema) {
      const cacheKey = `${projectRef}:${schema}`
      this.functionCache.delete(cacheKey)
      this.cacheExpiry.delete(cacheKey)
    } else {
      // Clear all cache entries for the project
      for (const key of this.functionCache.keys()) {
        if (key.startsWith(`${projectRef}:`)) {
          this.functionCache.delete(key)
          this.cacheExpiry.delete(key)
        }
      }
    }
  }

  /**
   * Check if cache is valid for a given key
   */
  private isCacheValid(cacheKey: string): boolean {
    const expiry = this.cacheExpiry.get(cacheKey)
    return expiry !== undefined && Date.now() < expiry
  }

  /**
   * Parse function parameters from PostgreSQL system catalogs
   */
  private parseParameters(
    argumentsString: string,
    paramNames: string[],
    paramTypes: string[],
    paramHasDefaults: boolean[]
  ): FunctionParameter[] {
    const parameters: FunctionParameter[] = []

    // If we have parameter information from the system catalogs
    if (paramTypes.length > 0) {
      for (let i = 0; i < paramTypes.length; i++) {
        parameters.push({
          name: paramNames[i] || `param_${i + 1}`,
          type: paramTypes[i] || 'unknown',
          isRequired: !(paramHasDefaults[i] || false),
          defaultValue: paramHasDefaults[i] ? undefined : undefined // We don't extract actual default values
        })
      }
    } else if (argumentsString) {
      // Fallback: parse from the arguments string
      // This is a simplified parser - in production, you'd want more robust parsing
      const args = argumentsString.split(',').map(arg => arg.trim())
      
      args.forEach((arg, index) => {
        const parts = arg.split(' ')
        const name = parts[0] || `param_${index + 1}`
        const type = parts[1] || 'unknown'
        const hasDefault = arg.includes('DEFAULT') || arg.includes('=')

        parameters.push({
          name,
          type,
          isRequired: !hasDefault,
          defaultValue: hasDefault ? undefined : undefined
        })
      })
    }

    return parameters
  }

  /**
   * Validate parameter type (basic validation)
   */
  private validateParameterType(expectedType: string, value: any): { isValid: boolean; error?: string } {
    if (value === null || value === undefined) {
      return { isValid: true } // NULL values are generally acceptable
    }

    const type = expectedType.toLowerCase()

    // Basic type validation
    if (type.includes('int') || type.includes('serial') || type.includes('bigint')) {
      if (!Number.isInteger(Number(value))) {
        return { isValid: false, error: `Expected integer, got ${typeof value}` }
      }
    } else if (type.includes('numeric') || type.includes('decimal') || type.includes('float') || type.includes('double')) {
      if (isNaN(Number(value))) {
        return { isValid: false, error: `Expected number, got ${typeof value}` }
      }
    } else if (type.includes('bool')) {
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false' && value !== 't' && value !== 'f') {
        return { isValid: false, error: `Expected boolean, got ${typeof value}` }
      }
    } else if (type.includes('json') || type.includes('jsonb')) {
      if (typeof value !== 'object' && typeof value !== 'string') {
        return { isValid: false, error: `Expected JSON object or string, got ${typeof value}` }
      }
    } else if (type.includes('text') || type.includes('varchar') || type.includes('char')) {
      if (typeof value !== 'string') {
        return { isValid: false, error: `Expected string, got ${typeof value}` }
      }
    } else if (type.includes('timestamp') || type.includes('date') || type.includes('time')) {
      const dateValue = new Date(value)
      if (isNaN(dateValue.getTime())) {
        return { isValid: false, error: `Expected valid date/time, got ${typeof value}` }
      }
    } else if (type.includes('uuid')) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      if (typeof value !== 'string' || !uuidRegex.test(value)) {
        return { isValid: false, error: `Expected valid UUID, got ${typeof value}` }
      }
    }

    return { isValid: true }
  }
}

/**
 * Database function definition
 * Requirements: 1.1
 */
export interface DatabaseFunction {
  name: string
  schema: string
  parameters: FunctionParameter[]
  returnType: string
  isSetReturning: boolean
  description?: string
}

/**
 * Function parameter definition
 * Requirements: 1.2
 */
export interface FunctionParameter {
  name: string
  type: string
  isRequired: boolean
  defaultValue?: any
}

/**
 * Function validation result
 * Requirements: 1.2
 */
export interface ValidationResult {
  isValid: boolean
  error?: string
  code?: string
  function?: DatabaseFunction
}

/**
 * Function execution result
 * Requirements: 1.3, 1.4
 */
export interface FunctionResult {
  success: boolean
  data: any
  returnType: string
  executionTime: number
  error?: string
  rowCount: number
}

/**
 * Factory function to get the RPC function service
 */
export function getRPCFunctionService(): RPCFunctionService {
  return RPCFunctionService.getInstance()
}