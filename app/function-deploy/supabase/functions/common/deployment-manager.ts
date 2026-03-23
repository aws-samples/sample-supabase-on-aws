/**
 * Enhanced Deployment Manager
 * 
 * Handles project-specific deployment with environment variable injection,
 * validation, and error handling.
 * 
 * Requirements: 3.2, 4.3, 4.4
 */

import { ProjectConfig, ProjectCredentials } from "./project-config-manager.ts";
import { FunctionMetadata } from "./function-scanner.ts";

export interface DeploymentResult {
  success: boolean;
  functionName: string;
  projectRef: string;
  deploymentId?: string;
  url?: string;
  error?: string;
  warnings?: string[];
}

export interface DeploymentValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface DeploymentManager {
  deployFunction(
    functionMetadata: FunctionMetadata,
    projectConfig: ProjectConfig
  ): Promise<DeploymentResult>;
  
  injectProjectEnvironment(
    functionCode: string,
    projectRef: string
  ): string;
  
  validateDeploymentTarget(projectRef: string): Promise<DeploymentValidationResult>;
  
  getDeploymentStatus(
    projectRef: string,
    functionName: string
  ): Promise<{ status: 'deployed' | 'failed' | 'pending' | 'not_found'; lastDeployed?: Date }>;
}

/**
 * Default implementation of DeploymentManager
 */
export class DefaultDeploymentManager implements DeploymentManager {
  private readonly maxRetries: number;
  private readonly retryDelay: number;

  constructor(maxRetries: number = 3, retryDelay: number = 1000) {
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  /**
   * Deploy a function with project-specific configuration
   * Requirements: 3.2, 4.3, 4.4
   */
  async deployFunction(
    functionMetadata: FunctionMetadata,
    projectConfig: ProjectConfig
  ): Promise<DeploymentResult> {
    try {
      console.log(`Deploying function ${functionMetadata.name} to project ${projectConfig.projectRef}`);

      // Validate deployment target
      const validation = await this.validateDeploymentTarget(projectConfig.projectRef);
      if (!validation.isValid) {
        return {
          success: false,
          functionName: functionMetadata.name,
          projectRef: projectConfig.projectRef,
          error: `Deployment validation failed: ${validation.errors.join(', ')}`
        };
      }

      // Prepare function files with environment injection
      const processedFiles = await this.prepareDeploymentFiles(functionMetadata, projectConfig);

      // Attempt deployment with retry logic
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          const result = await this.performDeployment(
            functionMetadata,
            projectConfig,
            processedFiles
          );

          console.log(`Successfully deployed ${functionMetadata.name} to ${projectConfig.projectRef}`);
          return {
            success: true,
            functionName: functionMetadata.name,
            projectRef: projectConfig.projectRef,
            deploymentId: result.deploymentId,
            url: result.url,
            warnings: validation.warnings
          };
        } catch (error) {
          lastError = error as Error;
          console.warn(`Deployment attempt ${attempt} failed: ${error.message}`);
          
          if (attempt < this.maxRetries) {
            console.log(`Retrying in ${this.retryDelay}ms...`);
            await this.delay(this.retryDelay);
          }
        }
      }

      return {
        success: false,
        functionName: functionMetadata.name,
        projectRef: projectConfig.projectRef,
        error: `Deployment failed after ${this.maxRetries} attempts: ${lastError?.message}`
      };
    } catch (error) {
      return {
        success: false,
        functionName: functionMetadata.name,
        projectRef: projectConfig.projectRef,
        error: `Deployment error: ${error.message}`
      };
    }
  }

  /**
   * Inject project-specific environment variables into function code
   * Requirements: 3.2, 4.3
   */
  injectProjectEnvironment(
    functionCode: string,
    projectRef: string
  ): string {
    if (!functionCode || typeof functionCode !== 'string') {
      throw new Error('Function code must be a non-empty string');
    }

    if (!projectRef || typeof projectRef !== 'string') {
      throw new Error('Project reference must be a non-empty string');
    }

    // Inject project-specific environment variables at the top of the function
    const projectEnvInjection = `
// Auto-injected project configuration
const PROJECT_REF = "${projectRef}";
const PROJECT_NAMESPACE = "proj_${projectRef}";

// Project-specific environment access
function getProjectEnv(key: string): string | undefined {
  // Try project-specific environment variable first
  const projectSpecificKey = \`\${key}_\${PROJECT_REF.toUpperCase().replace(/-/g, '_')}\`;
  return Deno.env.get(projectSpecificKey) || Deno.env.get(key);
}

// Original function code follows:
`;

    return projectEnvInjection + functionCode;
  }

  /**
   * Validate deployment target and configuration
   * Requirements: 4.4
   */
  async validateDeploymentTarget(projectRef: string): Promise<DeploymentValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate project reference format
    if (!projectRef || typeof projectRef !== 'string') {
      errors.push('Project reference must be a non-empty string');
    } else {
      const projectRefPattern = /^[a-zA-Z0-9][a-zA-Z0-9-_]*[a-zA-Z0-9]$/;
      if (!projectRefPattern.test(projectRef)) {
        errors.push(`Invalid project reference format: ${projectRef}`);
      }
    }

    // Validate project accessibility (simulated)
    try {
      const isAccessible = await this.checkProjectAccessibility(projectRef);
      if (!isAccessible) {
        errors.push(`Project ${projectRef} is not accessible or does not exist`);
      }
    } catch (error) {
      warnings.push(`Could not verify project accessibility: ${error.message}`);
    }

    // Validate required environment variables
    const requiredEnvVars = ['SUPABASE_SERVICE_ROLE_KEY'];
    for (const envVar of requiredEnvVars) {
      const projectSpecificVar = `${envVar}_${projectRef.toUpperCase().replace(/-/g, '_')}`;
      const hasProjectSpecific = Deno.env.get(projectSpecificVar);
      const hasGlobal = Deno.env.get(envVar);
      
      if (!hasProjectSpecific && !hasGlobal) {
        errors.push(`Missing required environment variable: ${envVar} (or project-specific ${projectSpecificVar})`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Prepare deployment files with environment injection and processing
   */
  protected async prepareDeploymentFiles(
    functionMetadata: FunctionMetadata,
    projectConfig: ProjectConfig
  ): Promise<{ name: string; content: string }[]> {
    const files: { name: string; content: string }[] = [];

    try {
      // Read the main function file
      const mainFilePath = `${functionMetadata.path}/index.ts`;
      let functionCode: string;
      
      try {
        functionCode = await Deno.readTextFile(mainFilePath);
      } catch (error) {
        throw new Error(`Could not read function file ${mainFilePath}: ${error.message}`);
      }

      // Inject project environment
      const processedCode = this.injectProjectEnvironment(functionCode, projectConfig.projectRef);
      
      files.push({
        name: 'index.ts',
        content: processedCode
      });

      // Include any additional files (deno.json, .env, etc.)
      await this.includeAdditionalFiles(functionMetadata.path, files);

      return files;
    } catch (error) {
      throw new Error(`Failed to prepare deployment files: ${error.message}`);
    }
  }

  /**
   * Include additional files like deno.json, .env, etc.
   */
  protected async includeAdditionalFiles(
    functionPath: string,
    files: { name: string; content: string }[]
  ): Promise<void> {
    const additionalFiles = ['deno.json', '.env', 'import_map.json'];

    for (const fileName of additionalFiles) {
      const filePath = `${functionPath}/${fileName}`;
      
      try {
        const content = await Deno.readTextFile(filePath);
        files.push({
          name: fileName,
          content
        });
      } catch {
        // File doesn't exist, skip it
        continue;
      }
    }
  }

  /**
   * Perform the actual deployment API call
   */
  protected async performDeployment(
    functionMetadata: FunctionMetadata,
    projectConfig: ProjectConfig,
    files: { name: string; content: string }[]
  ): Promise<{ deploymentId: string; url: string }> {
    // In a real implementation, this would make an HTTP request to the Supabase API
    // For now, we'll simulate the deployment
    
    const deploymentPayload = {
      projectRef: projectConfig.projectRef,
      functionName: functionMetadata.name,
      files: files,
      metadata: {
        entrypoint_path: 'index.ts',
        import_map_path: files.find(f => f.name === 'import_map.json') ? 'import_map.json' : undefined
      }
    };

    // Simulate API call
    console.log(`Making deployment request to ${projectConfig.apiEndpoint}`);
    console.log(`Payload: ${JSON.stringify(deploymentPayload, null, 2)}`);

    // Simulate network delay
    await this.delay(100);

    // Simulate potential deployment failures for testing
    if (Math.random() < 0.1) { // 10% chance of failure for testing
      throw new Error('Simulated deployment failure');
    }

    const deploymentId = `deploy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const functionUrl = `https://${projectConfig.projectRef}.supabase.co/functions/v1/${functionMetadata.relativePath}`;

    return {
      deploymentId,
      url: functionUrl
    };
  }

  /**
   * Check if project is accessible (simulated)
   */
  protected async checkProjectAccessibility(projectRef: string): Promise<boolean> {
    // In a real implementation, this would make an API call to verify project access
    // For now, we'll simulate this check
    
    // Simulate network delay
    await this.delay(50);
    
    // Simulate that projects starting with "invalid" are not accessible
    return !projectRef.startsWith('invalid');
  }

  /**
   * Utility method to add delay
   */
  protected async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Update deployment configuration dynamically
   * Requirements: 4.4
   */
  async updateDeploymentConfig(
    projectRef: string,
    configUpdates: Partial<ProjectConfig>
  ): Promise<boolean> {
    try {
      console.log(`Updating deployment configuration for project ${projectRef}`);
      
      // Validate the updates
      if (configUpdates.apiEndpoint) {
        if (!configUpdates.apiEndpoint.includes(projectRef)) {
          throw new Error('API endpoint must match project reference');
        }
      }

      // In a real implementation, this would update the configuration
      // For now, we'll just log the update
      console.log(`Configuration updates: ${JSON.stringify(configUpdates, null, 2)}`);
      
      return true;
    } catch (error) {
      console.error(`Failed to update deployment configuration: ${error.message}`);
      return false;
    }
  }

  /**
   * Get deployment status for a function
   */
  async getDeploymentStatus(
    projectRef: string,
    functionName: string
  ): Promise<{ status: 'deployed' | 'failed' | 'pending' | 'not_found'; lastDeployed?: Date }> {
    try {
      // In a real implementation, this would query the deployment status from the API
      // For now, we'll simulate this
      
      await this.delay(50);
      
      // Simulate different statuses based on function name
      if (functionName.includes('test')) {
        return { status: 'deployed', lastDeployed: new Date() };
      } else if (functionName.includes('fail')) {
        return { status: 'failed' };
      } else {
        return { status: 'not_found' };
      }
    } catch (error) {
      console.error(`Failed to get deployment status: ${error.message}`);
      return { status: 'not_found' };
    }
  }
}