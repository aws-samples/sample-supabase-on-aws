/**
 * Import Map Service for Edge Functions
 * 
 * Manages import maps and dependency resolution for Edge Functions.
 * Supports both local file system and S3 storage backends with Deno import resolution.
 */

import { FunctionFile } from './storage/StorageBackend'

/**
 * Import map entry
 */
export interface ImportMapEntry {
  /** Module specifier (e.g., "react") */
  specifier: string
  /** Resolved URL (e.g., "https://esm.sh/react@18.2.0") */
  url: string
  /** Whether this is a scoped import */
  scoped?: boolean
  /** Scope prefix for scoped imports */
  scope?: string
}

/**
 * Import map configuration
 */
export interface ImportMapConfig {
  /** Base imports */
  imports: Record<string, string>
  /** Scoped imports */
  scopes?: Record<string, Record<string, string>>
}

/**
 * Dependency information
 */
export interface DependencyInfo {
  /** Package name */
  name: string
  /** Package version */
  version?: string
  /** Package URL */
  url: string
  /** Dependency type */
  type: 'npm' | 'deno' | 'url' | 'local'
  /** Whether this is a dev dependency */
  dev?: boolean
}

/**
 * Static file configuration
 */
export interface StaticFileConfig {
  /** File patterns to serve as static files */
  patterns: string[]
  /** Base path for static files */
  basePath?: string
  /** Cache control headers */
  cacheControl?: string
}

/**
 * Import map validation result
 */
export interface ImportMapValidationResult {
  /** Whether the import map is valid */
  valid: boolean
  /** Validation errors */
  errors: string[]
  /** Validation warnings */
  warnings: string[]
  /** Resolved dependencies */
  dependencies: DependencyInfo[]
  /** Static file patterns */
  staticFiles: string[]
}

/**
 * Import Map Service
 * 
 * Provides comprehensive import map management and dependency resolution
 * for Edge Functions with support for both storage backends.
 */
export class ImportMapService {
  /**
   * Create import map from dependencies
   * 
   * @param dependencies - List of dependencies
   * @param scopes - Optional scoped imports
   * @returns Import map configuration
   */
  createImportMap(
    dependencies: DependencyInfo[],
    scopes?: Record<string, DependencyInfo[]>
  ): ImportMapConfig {
    const imports: Record<string, string> = {}
    const scopesConfig: Record<string, Record<string, string>> = {}

    // Process main dependencies
    for (const dep of dependencies) {
      if (!dep.dev) {
        imports[dep.name] = dep.url
        
        // Add common sub-paths for npm packages
        if (dep.type === 'npm') {
          imports[`${dep.name}/`] = `${dep.url}/`
        }
      }
    }

    // Process scoped dependencies
    if (scopes) {
      for (const [scope, scopeDeps] of Object.entries(scopes)) {
        scopesConfig[scope] = {}
        for (const dep of scopeDeps) {
          scopesConfig[scope][dep.name] = dep.url
          
          if (dep.type === 'npm') {
            scopesConfig[scope][`${dep.name}/`] = `${dep.url}/`
          }
        }
      }
    }

    return {
      imports,
      scopes: Object.keys(scopesConfig).length > 0 ? scopesConfig : undefined,
    }
  }

  /**
   * Parse import map from JSON string
   * 
   * @param importMapJson - Import map JSON string
   * @returns Parsed import map configuration
   */
  parseImportMap(importMapJson: string): ImportMapConfig {
    try {
      const parsed = JSON.parse(importMapJson)
      
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Import map must be an object')
      }

      const config: ImportMapConfig = {
        imports: parsed.imports || {},
      }

      if (parsed.scopes && typeof parsed.scopes === 'object') {
        config.scopes = parsed.scopes
      }

      return config

    } catch (error) {
      throw new Error(`Failed to parse import map: ${error instanceof Error ? error.message : 'Invalid JSON'}`)
    }
  }

  /**
   * Serialize import map to JSON string
   * 
   * @param config - Import map configuration
   * @returns JSON string
   */
  serializeImportMap(config: ImportMapConfig): string {
    const output: any = {
      imports: config.imports,
    }

    if (config.scopes && Object.keys(config.scopes).length > 0) {
      output.scopes = config.scopes
    }

    return JSON.stringify(output, null, 2)
  }

  /**
   * Validate import map configuration
   * 
   * @param config - Import map configuration
   * @returns Validation result
   */
  async validateImportMap(config: ImportMapConfig): Promise<ImportMapValidationResult> {
    const errors: string[] = []
    const warnings: string[] = []
    const dependencies: DependencyInfo[] = []
    const staticFiles: string[] = []

    try {
      // Validate imports
      if (config.imports) {
        for (const [specifier, url] of Object.entries(config.imports)) {
          const validation = await this.validateImportEntry(specifier, url)
          
          if (!validation.valid) {
            errors.push(`Invalid import "${specifier}": ${validation.error}`)
          } else {
            if (validation.dependency) {
              dependencies.push(validation.dependency)
            }
            if (validation.warnings) {
              warnings.push(...validation.warnings)
            }
          }
        }
      }

      // Validate scoped imports
      if (config.scopes) {
        for (const [scope, scopeImports] of Object.entries(config.scopes)) {
          if (!this.isValidScope(scope)) {
            errors.push(`Invalid scope "${scope}": must be a valid URL or path`)
            continue
          }

          for (const [specifier, url] of Object.entries(scopeImports)) {
            const validation = await this.validateImportEntry(specifier, url)
            
            if (!validation.valid) {
              errors.push(`Invalid scoped import "${scope}" -> "${specifier}": ${validation.error}`)
            } else {
              if (validation.dependency) {
                dependencies.push({
                  ...validation.dependency,
                  name: `${scope}/${validation.dependency.name}`,
                })
              }
              if (validation.warnings) {
                warnings.push(...validation.warnings)
              }
            }
          }
        }
      }

      // Check for duplicate dependencies
      const depNames = new Set<string>()
      for (const dep of dependencies) {
        if (depNames.has(dep.name)) {
          warnings.push(`Duplicate dependency: ${dep.name}`)
        } else {
          depNames.add(dep.name)
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        dependencies,
        staticFiles,
      }

    } catch (error) {
      return {
        valid: false,
        errors: [`Import map validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        warnings,
        dependencies,
        staticFiles,
      }
    }
  }

  /**
   * Validate a single import entry
   * 
   * @param specifier - Import specifier
   * @param url - Import URL
   * @returns Validation result
   */
  private async validateImportEntry(specifier: string, url: string): Promise<{
    valid: boolean
    error?: string
    warnings?: string[]
    dependency?: DependencyInfo
  }> {
    const warnings: string[] = []

    // Validate specifier
    if (!specifier || typeof specifier !== 'string') {
      return { valid: false, error: 'Specifier must be a non-empty string' }
    }

    // Validate URL
    if (!url || typeof url !== 'string') {
      return { valid: false, error: 'URL must be a non-empty string' }
    }

    try {
      // Parse URL to validate format
      const parsedUrl = new URL(url)
      
      // Determine dependency type and extract info
      const dependency = this.extractDependencyInfo(specifier, parsedUrl)
      
      // Check for common issues
      if (parsedUrl.protocol === 'http:') {
        warnings.push(`Insecure HTTP URL for "${specifier}": consider using HTTPS`)
      }

      if (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1') {
        warnings.push(`Local URL for "${specifier}": may not work in production`)
      }

      return {
        valid: true,
        warnings: warnings.length > 0 ? warnings : undefined,
        dependency,
      }

    } catch (error) {
      return {
        valid: false,
        error: `Invalid URL format: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }
    }
  }

  /**
   * Extract dependency information from URL
   * 
   * @param specifier - Import specifier
   * @param url - Parsed URL
   * @returns Dependency information
   */
  private extractDependencyInfo(specifier: string, url: URL): DependencyInfo {
    const hostname = url.hostname.toLowerCase()
    
    // ESM.sh (npm packages)
    if (hostname === 'esm.sh') {
      const match = url.pathname.match(/^\/([^@\/]+)(?:@([^\/]+))?/)
      return {
        name: specifier,
        version: match?.[2],
        url: url.toString(),
        type: 'npm',
      }
    }

    // Skypack (npm packages)
    if (hostname === 'cdn.skypack.dev') {
      const match = url.pathname.match(/^\/([^@\/]+)(?:@([^\/]+))?/)
      return {
        name: specifier,
        version: match?.[2],
        url: url.toString(),
        type: 'npm',
      }
    }

    // JSDelivr (npm packages)
    if (hostname === 'cdn.jsdelivr.net') {
      const match = url.pathname.match(/^\/npm\/([^@\/]+)(?:@([^\/]+))?/)
      return {
        name: specifier,
        version: match?.[2],
        url: url.toString(),
        type: 'npm',
      }
    }

    // Deno.land
    if (hostname === 'deno.land') {
      const match = url.pathname.match(/^\/std@([^\/]+)/) || url.pathname.match(/^\/x\/([^@\/]+)(?:@([^\/]+))?/)
      return {
        name: specifier,
        version: match?.[1] || match?.[2],
        url: url.toString(),
        type: 'deno',
      }
    }

    // Local files
    if (url.protocol === 'file:' || url.pathname.startsWith('./') || url.pathname.startsWith('../')) {
      return {
        name: specifier,
        url: url.toString(),
        type: 'local',
      }
    }

    // Generic URL
    return {
      name: specifier,
      url: url.toString(),
      type: 'url',
    }
  }

  /**
   * Check if scope is valid
   * 
   * @param scope - Scope string
   * @returns Whether scope is valid
   */
  private isValidScope(scope: string): boolean {
    if (!scope || typeof scope !== 'string') {
      return false
    }

    // Check if it's a valid URL
    try {
      new URL(scope)
      return true
    } catch {
      // Not a URL, check if it's a valid path
      return scope.startsWith('./') || scope.startsWith('../') || scope.startsWith('/')
    }
  }

  /**
   * Generate import map for common dependencies
   * 
   * @param packages - Package names with optional versions
   * @returns Generated import map configuration
   */
  generateCommonImportMap(packages: Array<{ name: string; version?: string; cdn?: 'esm.sh' | 'skypack' | 'jsdelivr' }>): ImportMapConfig {
    const imports: Record<string, string> = {}

    for (const pkg of packages) {
      const cdn = pkg.cdn || 'esm.sh'
      const version = pkg.version ? `@${pkg.version}` : ''
      
      switch (cdn) {
        case 'esm.sh':
          imports[pkg.name] = `https://esm.sh/${pkg.name}${version}`
          imports[`${pkg.name}/`] = `https://esm.sh/${pkg.name}${version}/`
          break
          
        case 'skypack':
          imports[pkg.name] = `https://cdn.skypack.dev/${pkg.name}${version}`
          imports[`${pkg.name}/`] = `https://cdn.skypack.dev/${pkg.name}${version}/`
          break
          
        case 'jsdelivr':
          imports[pkg.name] = `https://cdn.jsdelivr.net/npm/${pkg.name}${version}`
          imports[`${pkg.name}/`] = `https://cdn.jsdelivr.net/npm/${pkg.name}${version}/`
          break
      }
    }

    return { imports }
  }

  /**
   * Extract dependencies from function files
   * 
   * @param files - Function files
   * @returns Extracted dependencies
   */
  extractDependenciesFromFiles(files: FunctionFile[]): DependencyInfo[] {
    const dependencies: DependencyInfo[] = []
    const seenDeps = new Set<string>()

    for (const file of files) {
      if (file.name.endsWith('.ts') || file.name.endsWith('.js')) {
        const fileDeps = this.extractDependenciesFromCode(file.content)
        
        for (const dep of fileDeps) {
          if (!seenDeps.has(dep.name)) {
            dependencies.push(dep)
            seenDeps.add(dep.name)
          }
        }
      }
    }

    return dependencies
  }

  /**
   * Extract dependencies from TypeScript/JavaScript code
   * 
   * @param code - Source code
   * @returns Extracted dependencies
   */
  private extractDependenciesFromCode(code: string): DependencyInfo[] {
    const dependencies: DependencyInfo[] = []
    
    // Regular expressions for different import patterns
    const importPatterns = [
      // ES6 imports: import ... from "module"
      /import\s+(?:[\w\s{},*]+\s+from\s+)?["']([^"']+)["']/g,
      // Dynamic imports: import("module")
      /import\s*\(\s*["']([^"']+)["']\s*\)/g,
      // Deno imports: from "https://..."
      /from\s+["'](https?:\/\/[^"']+)["']/g,
    ]

    for (const pattern of importPatterns) {
      let match
      while ((match = pattern.exec(code)) !== null) {
        const importPath = match[1]
        
        if (importPath && !importPath.startsWith('.')) {
          try {
            const url = new URL(importPath)
            const dep = this.extractDependencyInfo(importPath, url)
            dependencies.push(dep)
          } catch {
            // Not a URL, might be a bare specifier
            if (!importPath.startsWith('/')) {
              dependencies.push({
                name: importPath,
                url: importPath,
                type: 'npm', // Assume npm for bare specifiers
              })
            }
          }
        }
      }
    }

    return dependencies
  }

  /**
   * Create static file configuration from function files
   * 
   * @param files - Function files
   * @returns Static file configuration
   */
  createStaticFileConfig(files: FunctionFile[]): StaticFileConfig {
    const patterns: string[] = []
    
    for (const file of files) {
      // Identify static files by extension and path
      const isStaticFile = 
        file.path.startsWith('static/') ||
        file.path.startsWith('assets/') ||
        file.path.startsWith('public/') ||
        /\.(css|html|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot)$/i.test(file.name)

      if (isStaticFile) {
        patterns.push(file.path)
      }
    }

    return {
      patterns,
      basePath: '/static',
      cacheControl: 'public, max-age=3600', // 1 hour cache
    }
  }

  /**
   * Merge multiple import maps
   * 
   * @param importMaps - Array of import map configurations
   * @returns Merged import map configuration
   */
  mergeImportMaps(importMaps: ImportMapConfig[]): ImportMapConfig {
    const mergedImports: Record<string, string> = {}
    const mergedScopes: Record<string, Record<string, string>> = {}

    for (const config of importMaps) {
      // Merge imports (later configs override earlier ones)
      Object.assign(mergedImports, config.imports)

      // Merge scopes
      if (config.scopes) {
        for (const [scope, scopeImports] of Object.entries(config.scopes)) {
          if (!mergedScopes[scope]) {
            mergedScopes[scope] = {}
          }
          Object.assign(mergedScopes[scope], scopeImports)
        }
      }
    }

    return {
      imports: mergedImports,
      scopes: Object.keys(mergedScopes).length > 0 ? mergedScopes : undefined,
    }
  }

  /**
   * Optimize import map by removing unused imports
   * 
   * @param config - Import map configuration
   * @param files - Function files to check usage against
   * @returns Optimized import map configuration
   */
  optimizeImportMap(config: ImportMapConfig, files: FunctionFile[]): ImportMapConfig {
    const usedImports = new Set<string>()
    
    // Extract all import specifiers used in the code
    for (const file of files) {
      if (file.name.endsWith('.ts') || file.name.endsWith('.js')) {
        const deps = this.extractDependenciesFromCode(file.content)
        for (const dep of deps) {
          usedImports.add(dep.name)
          // Also add potential sub-path imports
          if (dep.name.includes('/')) {
            const baseName = dep.name.split('/')[0]
            usedImports.add(baseName)
          }
        }
      }
    }

    // Filter imports to only include used ones
    const optimizedImports: Record<string, string> = {}
    for (const [specifier, url] of Object.entries(config.imports)) {
      if (usedImports.has(specifier) || usedImports.has(specifier.replace('/', ''))) {
        optimizedImports[specifier] = url
      }
    }

    // Filter scopes similarly
    const optimizedScopes: Record<string, Record<string, string>> = {}
    if (config.scopes) {
      for (const [scope, scopeImports] of Object.entries(config.scopes)) {
        const filteredScopeImports: Record<string, string> = {}
        
        for (const [specifier, url] of Object.entries(scopeImports)) {
          if (usedImports.has(specifier) || usedImports.has(specifier.replace('/', ''))) {
            filteredScopeImports[specifier] = url
          }
        }
        
        if (Object.keys(filteredScopeImports).length > 0) {
          optimizedScopes[scope] = filteredScopeImports
        }
      }
    }

    return {
      imports: optimizedImports,
      scopes: Object.keys(optimizedScopes).length > 0 ? optimizedScopes : undefined,
    }
  }
}

/**
 * Singleton instance
 */
let importMapService: ImportMapService | null = null

/**
 * Get the singleton ImportMapService instance
 */
export function getImportMapService(): ImportMapService {
  if (!importMapService) {
    importMapService = new ImportMapService()
  }
  return importMapService
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetImportMapService(): void {
  importMapService = null
}