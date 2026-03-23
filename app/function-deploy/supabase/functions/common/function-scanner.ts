import { join, resolve, relative } from "https://deno.land/std@0.208.0/path/mod.ts";
import { walk } from "https://deno.land/std@0.208.0/fs/walk.ts";
import { EnvironmentLoader, EnvironmentConfig } from "./environment-loader.ts";

/**
 * Metadata for a discovered function
 */
export interface FunctionMetadata {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  environmentConfig: EnvironmentConfig;
  dependencies: FunctionDependency[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Function dependency information
 */
export interface FunctionDependency {
  targetFunction: string;
  targetPath: string;
  dependencyType: 'call' | 'import' | 'shared';
}

// EnvironmentConfig is now imported from environment-loader.ts

/**
 * Enhanced function scanner for multi-level directory structures
 */
export interface FunctionScanner {
  scanFunctions(rootPath: string): Promise<FunctionMetadata[]>;
  validateFunctionStructure(functionPath: string): boolean;
  loadEnvironmentVariables(functionPath: string): EnvironmentConfig;
}

/**
 * Implementation of the enhanced function scanner
 */
export class EnhancedFunctionScanner implements FunctionScanner {
  private environmentLoader: EnvironmentLoader;

  constructor() {
    this.environmentLoader = new EnvironmentLoader();
  }
  
  /**
   * Recursively scan for functions in multi-level directories
   */
  async scanFunctions(rootPath: string): Promise<FunctionMetadata[]> {
    const functions: FunctionMetadata[] = [];
    const absoluteRootPath = resolve(rootPath);
    
    try {
      // Walk through all directories recursively
      for await (const entry of walk(absoluteRootPath, {
        includeDirs: true,
        includeFiles: false,
        skip: [/node_modules/, /\.git/, /\.deno/]
      })) {
        
        if (entry.isDirectory) {
          const functionPath = entry.path;
          
          // Check if this directory contains a valid function
          if (await this.validateFunctionStructure(functionPath)) {
            const relativePath = relative(absoluteRootPath, functionPath);
            const functionName = relativePath || entry.name;
            
            // Load environment configuration
            const environmentConfig = this.loadEnvironmentVariables(functionPath);
            
            // Detect dependencies (basic implementation)
            const dependencies = await this.detectDependencies(functionPath, absoluteRootPath);
            
            const metadata: FunctionMetadata = {
              id: this.generateFunctionId(functionName),
              name: functionName,
              path: functionPath,
              relativePath: relativePath,
              environmentConfig,
              dependencies,
              createdAt: new Date(),
              updatedAt: new Date()
            };
            
            functions.push(metadata);
          }
        }
      }
      
      return functions;
    } catch (error) {
      console.error(`Error scanning functions in ${rootPath}:`, error);
      throw new Error(`Failed to scan functions: ${(error as Error).message}`);
    }
  }

  /**
   * Validate that a directory contains a valid function structure
   */
  validateFunctionStructure(functionPath: string): boolean {
    try {
      // Check for required files
      const indexTsPath = join(functionPath, "index.ts");
      const indexJsPath = join(functionPath, "index.js");
      
      // A valid function must have either index.ts or index.js
      return Deno.statSync(indexTsPath).isFile || Deno.statSync(indexJsPath).isFile;
    } catch {
      // If we can't stat the files, they don't exist
      return false;
    }
  }

  /**
   * Load environment variables with proper precedence
   */
  loadEnvironmentVariables(functionPath: string): EnvironmentConfig {
    return this.environmentLoader.loadEnvironmentVariables(functionPath);
  }



  /**
   * Check if a file exists
   */
  private fileExists(path: string): boolean {
    try {
      return Deno.statSync(path).isFile;
    } catch {
      return false;
    }
  }

  /**
   * Generate a unique function ID
   */
  private generateFunctionId(functionName: string): string {
    return `func_${functionName.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
  }

  /**
   * Detect function dependencies (basic implementation)
   */
  private async detectDependencies(functionPath: string, rootPath: string): Promise<FunctionDependency[]> {
    const dependencies: FunctionDependency[] = [];
    
    try {
      // Look for index.ts or index.js
      const indexFiles = ['index.ts', 'index.js'];
      
      for (const indexFile of indexFiles) {
        const indexPath = join(functionPath, indexFile);
        
        if (this.fileExists(indexPath)) {
          const content = Deno.readTextFileSync(indexPath);
          
          // Simple regex to find imports from other functions
          // This is a basic implementation - could be enhanced with proper AST parsing
          const importRegex = /import.*from\s+['"](\.\.?\/[^'"]*)['"]/g;
          let match;
          
          while ((match = importRegex.exec(content)) !== null) {
            const importPath = match[1];
            const resolvedPath = resolve(functionPath, importPath);
            
            // Check if this import points to another function
            if (resolvedPath.startsWith(rootPath)) {
              const relativePath = relative(rootPath, resolvedPath);
              
              dependencies.push({
                targetFunction: relativePath,
                targetPath: resolvedPath,
                dependencyType: 'import'
              });
            }
          }
          
          break; // Only process the first found index file
        }
      }
    } catch (error) {
      console.error(`Error detecting dependencies for ${functionPath}:`, error);
    }
    
    return dependencies;
  }
}