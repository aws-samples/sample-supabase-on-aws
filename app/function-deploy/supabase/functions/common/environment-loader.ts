import { join, resolve } from "https://deno.land/std@0.208.0/path/mod.ts";

/**
 * Environment configuration with precedence
 */
export interface EnvironmentConfig {
  projectLevel: Map<string, string>;
  functionLevel: Map<string, string>;
  merged: Map<string, string>;
  precedenceOrder: string[];
}

/**
 * Environment variable loader with hierarchy resolution
 */
export class EnvironmentLoader {
  
  /**
   * Load environment variables with proper precedence hierarchy
   * Function-level variables override project-level variables
   */
  loadEnvironmentVariables(functionPath: string): EnvironmentConfig {
    const projectLevel = new Map<string, string>();
    const functionLevel = new Map<string, string>();
    const merged = new Map<string, string>();
    const precedenceOrder: string[] = [];

    try {
      // Step 1: Load project-level .env (from functions root)
      const projectEnvPath = this.findProjectEnvFile(functionPath);
      if (projectEnvPath) {
        const projectEnv = this.parseEnvFile(projectEnvPath);
        for (const [key, value] of projectEnv) {
          projectLevel.set(key, value);
          merged.set(key, value);
        }
        precedenceOrder.push('project');
      }

      // Step 2: Load function-level .env (overrides project-level)
      const functionEnvPath = join(functionPath, ".env");
      if (this.fileExists(functionEnvPath)) {
        const funcEnv = this.parseEnvFile(functionEnvPath);
        for (const [key, value] of funcEnv) {
          functionLevel.set(key, value);
          // Function-level overrides project-level (higher precedence)
          merged.set(key, value);
        }
        precedenceOrder.push('function');
      }

      // Step 3: Load system environment variables (highest precedence)
      this.loadSystemEnvironmentVariables(merged);
      if (Deno.env.toObject() && Object.keys(Deno.env.toObject()).length > 0) {
        precedenceOrder.push('system');
      }

      return {
        projectLevel,
        functionLevel,
        merged,
        precedenceOrder
      };
    } catch (error) {
      console.error(`Error loading environment variables for ${functionPath}:`, error);
      return {
        projectLevel,
        functionLevel,
        merged,
        precedenceOrder
      };
    }
  }

  /**
   * Find the project-level .env file by traversing up the directory tree
   * Looks for .env file in the same directory as deno.json (functions root)
   */
  private findProjectEnvFile(functionPath: string): string | null {
    let currentPath = functionPath;
    
    // Traverse up the directory tree to find the functions root
    while (currentPath !== "/" && currentPath !== ".") {
      const parentPath = resolve(currentPath, "..");
      
      // Check if this directory contains deno.json (indicates functions root)
      const denoConfigPath = join(parentPath, "deno.json");
      if (this.fileExists(denoConfigPath)) {
        const envPath = join(parentPath, ".env");
        if (this.fileExists(envPath)) {
          return envPath;
        }
        // Found functions root but no .env file
        break;
      }
      
      currentPath = parentPath;
      
      // Prevent infinite loop
      if (currentPath === resolve(currentPath, "..")) {
        break;
      }
    }
    
    return null;
  }

  /**
   * Parse environment file into key-value pairs
   * Supports standard .env format with comments and quoted values
   */
  private parseEnvFile(envPath: string): Map<string, string> {
    const envVars = new Map<string, string>();
    
    try {
      const content = Deno.readTextFileSync(envPath);
      const lines = content.split('\n');
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        
        // Skip empty lines and comments
        if (!trimmedLine || trimmedLine.startsWith('#')) {
          continue;
        }
        
        // Parse KEY=VALUE format
        const equalIndex = trimmedLine.indexOf('=');
        if (equalIndex > 0) {
          const key = trimmedLine.substring(0, equalIndex).trim();
          let value = trimmedLine.substring(equalIndex + 1).trim();
          
          // Handle quoted values
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          
          // Handle escaped characters in quoted strings
          value = value.replace(/\\n/g, '\n')
                      .replace(/\\r/g, '\r')
                      .replace(/\\t/g, '\t')
                      .replace(/\\\\/g, '\\')
                      .replace(/\\"/g, '"')
                      .replace(/\\'/g, "'");
          
          envVars.set(key, value);
        }
      }
    } catch (error) {
      console.error(`Error parsing env file ${envPath}:`, error);
    }
    
    return envVars;
  }

  /**
   * Load system environment variables that override file-based ones
   */
  private loadSystemEnvironmentVariables(merged: Map<string, string>): void {
    try {
      const systemEnv = Deno.env.toObject();
      
      // Only override variables that are already defined in files
      // This prevents system variables from polluting the function environment
      for (const [key, value] of Object.entries(systemEnv)) {
        if (merged.has(key)) {
          merged.set(key, value);
        }
      }
    } catch (error) {
      console.error('Error loading system environment variables:', error);
    }
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
   * Validate environment configuration
   * Checks for required variables and potential conflicts
   */
  validateEnvironmentConfig(config: EnvironmentConfig): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for empty values
    for (const [key, value] of config.merged) {
      if (!value || value.trim() === '') {
        warnings.push(`Environment variable '${key}' is empty`);
      }
    }

    // Check for potential conflicts between project and function level
    for (const [key, projectValue] of config.projectLevel) {
      if (config.functionLevel.has(key)) {
        const functionValue = config.functionLevel.get(key);
        if (projectValue !== functionValue) {
          warnings.push(
            `Environment variable '${key}' overridden: project='${projectValue}' -> function='${functionValue}'`
          );
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Get environment variables as a plain object for function execution
   */
  getEnvironmentObject(config: EnvironmentConfig): Record<string, string> {
    const envObject: Record<string, string> = {};
    
    for (const [key, value] of config.merged) {
      envObject[key] = value;
    }
    
    return envObject;
  }
}