import { getServiceRouter } from '../service-router'
import * as fs from 'fs/promises'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'

/**
 * Function metadata
 */
export interface FunctionMetadata {
  id: string
  name: string
  project_ref: string
  created_at: string
  updated_at: string
  version?: string
  status?: 'active' | 'inactive'
  entrypoint?: string
}

/**
 * Function deployment options
 */
export interface DeployFunctionOptions {
  entrypoint?: string
  version?: string
  importMap?: Record<string, string>
}

/**
 * Function invocation options
 */
export interface InvokeFunctionOptions {
  method?: string
  headers?: Record<string, string>
  body?: any
}

/**
 * Function invocation response
 */
export interface FunctionInvocationResponse {
  status: number
  headers: Record<string, string>
  body: any
  executionTime: number
}

/**
 * Functions Service Adapter
 * 
 * Provides project-isolated edge functions services.
 * Each project has its own function directory and environment variables.
 */
export class FunctionsServiceAdapter {
  private serviceRouter = getServiceRouter()
  
  // Base functions directory (configurable via environment variable)
  private readonly FUNCTIONS_BASE_PATH = process.env.FUNCTIONS_BASE_PATH || '/var/lib/functions'

  /**
   * Create project function directories
   * 
   * @param projectRef - The project reference
   */
  async createProjectDirectories(projectRef: string): Promise<void> {
    const projectPath = this.getProjectPath(projectRef)
    
    try {
      await fs.mkdir(projectPath, { recursive: true })
      console.log(`Created function directory for project: ${projectRef}`)
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        throw new Error(`Failed to create function directory: ${error.message}`)
      }
    }
  }

  /**
   * Delete project function directories
   * 
   * @param projectRef - The project reference
   */
  async deleteProjectDirectories(projectRef: string): Promise<void> {
    const projectPath = this.getProjectPath(projectRef)
    
    try {
      await fs.rm(projectPath, { recursive: true, force: true })
      console.log(`Deleted function directory for project: ${projectRef}`)
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error(`Failed to delete function directory: ${error.message}`)
      }
    }
  }

  /**
   * Get the project's functions directory path
   * 
   * @param projectRef - The project reference
   * @returns Project functions directory path
   */
  private getProjectPath(projectRef: string): string {
    return path.join(this.FUNCTIONS_BASE_PATH, projectRef)
  }

  /**
   * Get the path for a specific function
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @returns Function directory path
   */
  private getFunctionPath(projectRef: string, functionName: string): string {
    return path.join(this.getProjectPath(projectRef), functionName)
  }

  /**
   * Get the path for a function's code file
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @returns Function code file path
   */
  private getFunctionCodePath(projectRef: string, functionName: string): string {
    return path.join(this.getFunctionPath(projectRef, functionName), 'index.ts')
  }

  /**
   * Get the path for a function's metadata file
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @returns Function metadata file path
   */
  private getFunctionMetadataPath(projectRef: string, functionName: string): string {
    return path.join(this.getFunctionPath(projectRef, functionName), 'metadata.json')
  }

  /**
   * Get the path for a function's environment variables file
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @returns Function env file path
   */
  private getFunctionEnvPath(projectRef: string, functionName: string): string {
    return path.join(this.getFunctionPath(projectRef, functionName), '.env')
  }

  /**
   * Validate function name
   * 
   * @param functionName - The function name
   * @throws Error if function name is invalid
   */
  private validateFunctionName(functionName: string): void {
    if (!functionName || functionName.length === 0) {
      throw new Error('Function name is required')
    }

    // Function name validation (lowercase alphanumeric, hyphens, and underscores only)
    if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(functionName)) {
      throw new Error(
        'Function name must start and end with alphanumeric characters and contain only lowercase letters, numbers, hyphens, and underscores'
      )
    }

    // Reserved names
    const reservedNames = ['index', 'main', 'handler', 'function']
    if (reservedNames.includes(functionName)) {
      throw new Error(`Function name '${functionName}' is reserved`)
    }
  }

  /**
   * Check if a function exists
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @returns True if function exists
   */
  async functionExists(projectRef: string, functionName: string): Promise<boolean> {
    const functionPath = this.getFunctionPath(projectRef, functionName)
    
    try {
      await fs.access(functionPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Deploy a function to a project
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @param code - The function code
   * @param options - Deployment options
   * @returns Function metadata
   */
  async deployFunction(
    projectRef: string,
    functionName: string,
    code: string,
    options: DeployFunctionOptions = {}
  ): Promise<FunctionMetadata> {
    // Validate function name
    this.validateFunctionName(functionName)

    // Validate code
    if (!code || code.trim().length === 0) {
      throw new Error('Function code is required')
    }

    const { entrypoint = 'handler', version = '1.0.0', importMap = {} } = options

    // Check if function already exists
    const exists = await this.functionExists(projectRef, functionName)
    const isUpdate = exists

    // Create function directory
    const functionPath = this.getFunctionPath(projectRef, functionName)
    await fs.mkdir(functionPath, { recursive: true })

    // Save function code
    const codePath = this.getFunctionCodePath(projectRef, functionName)
    await fs.writeFile(codePath, code, 'utf-8')

    // Create or update metadata
    const now = new Date().toISOString()
    const metadata: FunctionMetadata = {
      id: isUpdate ? (await this.getFunctionMetadata(projectRef, functionName))?.id || uuidv4() : uuidv4(),
      name: functionName,
      project_ref: projectRef,
      created_at: isUpdate ? (await this.getFunctionMetadata(projectRef, functionName))?.created_at || now : now,
      updated_at: now,
      version,
      status: 'active',
      entrypoint,
    }

    // Save metadata
    const metadataPath = this.getFunctionMetadataPath(projectRef, functionName)
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8')

    // Create import map file if provided
    if (Object.keys(importMap).length > 0) {
      const importMapPath = path.join(functionPath, 'import_map.json')
      await fs.writeFile(importMapPath, JSON.stringify({ imports: importMap }, null, 2), 'utf-8')
    }

    console.log(`${isUpdate ? 'Updated' : 'Deployed'} function '${functionName}' for project '${projectRef}'`)

    return metadata
  }

  /**
   * Get function metadata
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @returns Function metadata or null if not found
   */
  async getFunctionMetadata(
    projectRef: string,
    functionName: string
  ): Promise<FunctionMetadata | null> {
    const metadataPath = this.getFunctionMetadataPath(projectRef, functionName)

    try {
      const content = await fs.readFile(metadataPath, 'utf-8')
      return JSON.parse(content) as FunctionMetadata
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  /**
   * List all functions in a project
   * 
   * @param projectRef - The project reference
   * @returns Array of function metadata
   */
  async listFunctions(projectRef: string): Promise<FunctionMetadata[]> {
    const projectPath = this.getProjectPath(projectRef)

    try {
      const entries = await fs.readdir(projectPath, { withFileTypes: true })
      const functions: FunctionMetadata[] = []

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const metadata = await this.getFunctionMetadata(projectRef, entry.name)
          if (metadata) {
            functions.push(metadata)
          }
        }
      }

      return functions.sort((a, b) => a.name.localeCompare(b.name))
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return []
      }
      throw error
    }
  }

  /**
   * Delete a function
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   */
  async deleteFunction(projectRef: string, functionName: string): Promise<void> {
    const functionPath = this.getFunctionPath(projectRef, functionName)

    // Check if function exists first
    const exists = await this.functionExists(projectRef, functionName)
    if (!exists) {
      throw new Error(`Function '${functionName}' not found`)
    }

    try {
      await fs.rm(functionPath, { recursive: true, force: true })
      console.log(`Deleted function '${functionName}' from project '${projectRef}'`)
    } catch (error: any) {
      throw error
    }
  }

  /**
   * Get function code
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @returns Function code
   */
  async getFunctionCode(projectRef: string, functionName: string): Promise<string> {
    const codePath = this.getFunctionCodePath(projectRef, functionName)

    try {
      return await fs.readFile(codePath, 'utf-8')
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`Function '${functionName}' not found`)
      }
      throw error
    }
  }

  /**
   * Invoke a function
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @param payload - The invocation payload
   * @param options - Invocation options
   * @returns Function invocation response
   */
  async invokeFunction(
    projectRef: string,
    functionName: string,
    payload: any = {},
    options: InvokeFunctionOptions = {}
  ): Promise<FunctionInvocationResponse> {
    const startTime = Date.now()

    // Check if function exists
    const exists = await this.functionExists(projectRef, functionName)
    if (!exists) {
      throw new Error(`Function '${functionName}' not found in project '${projectRef}'`)
    }

    // Get function metadata
    const metadata = await this.getFunctionMetadata(projectRef, functionName)
    if (!metadata || metadata.status !== 'active') {
      throw new Error(`Function '${functionName}' is not active`)
    }

    // Load function code
    const code = await this.getFunctionCode(projectRef, functionName)

    // Load environment variables
    const envVars = await this.loadEnvVars(projectRef, functionName)

    // Get project database connection
    const projectConfig = await this.serviceRouter.getProjectConfig(projectRef)
    if (!projectConfig) {
      throw new Error(`Project '${projectRef}' not found`)
    }

    // Prepare execution context
    const context = {
      projectRef,
      functionName,
      databaseUrl: projectConfig.connectionString,
      env: envVars,
    }

    // Execute function
    try {
      const result = await this.executeFunction(
        code,
        payload,
        context,
        options,
        metadata.entrypoint || 'handler'
      )

      const executionTime = Date.now() - startTime

      return {
        status: result.status || 200,
        headers: result.headers || { 'Content-Type': 'application/json' },
        body: result.body,
        executionTime,
      }
    } catch (error: any) {
      const executionTime = Date.now() - startTime

      console.error(`Function execution error for '${functionName}':`, error)

      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: {
          error: 'Function execution failed',
          message: error.message,
        },
        executionTime,
      }
    }
  }

  /**
   * Execute a function in an isolated context
   * 
   * @param code - The function code
   * @param payload - The invocation payload
   * @param context - The execution context
   * @param options - Invocation options
   * @param entrypoint - The entrypoint function name
   * @returns Execution result
   */
  private async executeFunction(
    code: string,
    payload: any,
    context: any,
    options: InvokeFunctionOptions,
    entrypoint: string
  ): Promise<any> {
    // Create a mock Request object
    const { method = 'POST', headers = {}, body = payload } = options

    const request = {
      method,
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      url: `http://localhost/functions/${context.functionName}`,
    }

    // Create execution environment
    const env = {
      ...context.env,
      PROJECT_REF: context.projectRef,
      DATABASE_URL: context.databaseUrl,
    }

    // Simple function execution using eval (in production, use a proper sandbox like vm2 or isolated-vm)
    // For now, we'll use a simplified approach
    try {
      // Create a function from the code
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const fn = new AsyncFunction('req', 'env', `
        ${code}
        
        // Call the entrypoint function
        if (typeof ${entrypoint} === 'function') {
          return await ${entrypoint}(req);
        } else if (typeof handler === 'function') {
          return await handler(req);
        } else {
          throw new Error('No handler function found');
        }
      `)

      const result = await fn(request, env)

      // Handle Response objects
      if (result && typeof result === 'object') {
        if (result.constructor && result.constructor.name === 'Response') {
          // It's a Response object
          return {
            status: result.status || 200,
            headers: Object.fromEntries(result.headers || []),
            body: await result.text(),
          }
        }
        
        // Plain object response
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: result,
        }
      }

      // String or primitive response
      return {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: String(result),
      }
    } catch (error: any) {
      throw new Error(`Function execution error: ${error.message}`)
    }
  }

  /**
   * Load environment variables for a function
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @returns Environment variables as key-value pairs
   */
  private async loadEnvVars(
    projectRef: string,
    functionName: string
  ): Promise<Record<string, string>> {
    const envPath = this.getFunctionEnvPath(projectRef, functionName)

    try {
      const content = await fs.readFile(envPath, 'utf-8')
      const envVars: Record<string, string> = {}

      // Parse .env file format
      const lines = content.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) {
          continue
        }

        // Parse KEY=VALUE format
        const match = trimmed.match(/^([^=]+)=(.*)$/)
        if (match) {
          const key = match[1].trim()
          let value = match[2].trim()

          // Remove quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
          }

          envVars[key] = value
        }
      }

      return envVars
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // No .env file, return empty object
        return {}
      }
      throw error
    }
  }

  /**
   * Set an environment variable for a function
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @param key - The environment variable key
   * @param value - The environment variable value
   */
  async setEnvVar(
    projectRef: string,
    functionName: string,
    key: string,
    value: string
  ): Promise<void> {
    // Validate inputs
    if (!key || key.trim().length === 0) {
      throw new Error('Environment variable key is required')
    }

    // Validate key format (uppercase letters, numbers, and underscores only)
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(
        'Environment variable key must contain only uppercase letters, numbers, and underscores, and start with a letter or underscore'
      )
    }

    // Check if function exists
    const exists = await this.functionExists(projectRef, functionName)
    if (!exists) {
      throw new Error(`Function '${functionName}' not found in project '${projectRef}'`)
    }

    // Load existing env vars
    const envVars = await this.loadEnvVars(projectRef, functionName)

    // Update or add the variable
    envVars[key] = value

    // Save env vars
    await this.saveEnvVars(projectRef, functionName, envVars)

    console.log(`Set environment variable '${key}' for function '${functionName}' in project '${projectRef}'`)
  }

  /**
   * Get an environment variable for a function
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @param key - The environment variable key
   * @returns The environment variable value or null if not found
   */
  async getEnvVar(
    projectRef: string,
    functionName: string,
    key: string
  ): Promise<string | null> {
    const envVars = await this.loadEnvVars(projectRef, functionName)
    return envVars[key] || null
  }

  /**
   * Delete an environment variable for a function
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @param key - The environment variable key
   */
  async deleteEnvVar(
    projectRef: string,
    functionName: string,
    key: string
  ): Promise<void> {
    // Load existing env vars
    const envVars = await this.loadEnvVars(projectRef, functionName)

    // Check if variable exists
    if (!(key in envVars)) {
      throw new Error(`Environment variable '${key}' not found`)
    }

    // Remove the variable
    delete envVars[key]

    // Save env vars
    await this.saveEnvVars(projectRef, functionName, envVars)

    console.log(`Deleted environment variable '${key}' for function '${functionName}' in project '${projectRef}'`)
  }

  /**
   * List all environment variables for a function
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @returns Environment variables as key-value pairs
   */
  async listEnvVars(
    projectRef: string,
    functionName: string
  ): Promise<Record<string, string>> {
    return this.loadEnvVars(projectRef, functionName)
  }

  /**
   * Set multiple environment variables for a function
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @param envVars - Environment variables as key-value pairs
   */
  async setEnvVars(
    projectRef: string,
    functionName: string,
    envVars: Record<string, string>
  ): Promise<void> {
    // Validate all keys
    for (const key of Object.keys(envVars)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        throw new Error(
          `Invalid environment variable key '${key}': must contain only uppercase letters, numbers, and underscores`
        )
      }
    }

    // Check if function exists
    const exists = await this.functionExists(projectRef, functionName)
    if (!exists) {
      throw new Error(`Function '${functionName}' not found in project '${projectRef}'`)
    }

    // Load existing env vars
    const existingEnvVars = await this.loadEnvVars(projectRef, functionName)

    // Merge with new vars
    const mergedEnvVars = { ...existingEnvVars, ...envVars }

    // Save env vars
    await this.saveEnvVars(projectRef, functionName, mergedEnvVars)

    console.log(`Set ${Object.keys(envVars).length} environment variables for function '${functionName}' in project '${projectRef}'`)
  }

  /**
   * Save environment variables to .env file
   * 
   * @param projectRef - The project reference
   * @param functionName - The function name
   * @param envVars - Environment variables as key-value pairs
   */
  private async saveEnvVars(
    projectRef: string,
    functionName: string,
    envVars: Record<string, string>
  ): Promise<void> {
    const envPath = this.getFunctionEnvPath(projectRef, functionName)

    // Format as .env file
    const lines: string[] = [
      '# Environment variables for function: ' + functionName,
      '# Project: ' + projectRef,
      '# Last updated: ' + new Date().toISOString(),
      '',
    ]

    // Sort keys for consistent output
    const sortedKeys = Object.keys(envVars).sort()

    for (const key of sortedKeys) {
      const value = envVars[key]
      
      // Escape quotes in value
      const escapedValue = value.replace(/"/g, '\\"')
      
      // Quote value if it contains spaces or special characters
      const needsQuotes = /[\s#]/.test(value)
      const formattedValue = needsQuotes ? `"${escapedValue}"` : value

      lines.push(`${key}=${formattedValue}`)
    }

    // Add trailing newline
    lines.push('')

    await fs.writeFile(envPath, lines.join('\n'), 'utf-8')
  }
}

// Singleton instance
let functionsServiceAdapter: FunctionsServiceAdapter | null = null

/**
 * Get the singleton FunctionsServiceAdapter instance
 */
export function getFunctionsServiceAdapter(): FunctionsServiceAdapter {
  if (!functionsServiceAdapter) {
    functionsServiceAdapter = new FunctionsServiceAdapter()
  }
  return functionsServiceAdapter
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetFunctionsServiceAdapter(): void {
  functionsServiceAdapter = null
}
