/**
 * CLI Integration Module
 * 
 * Integrates project configuration management and deployment functionality
 * to provide a seamless CLI experience for enhanced edge functions.
 * 
 * Requirements: 3.1, 3.2, 4.1, 4.2, 4.3
 */

import { DefaultProjectConfigManager, ProjectConfigManager, ProjectConfig } from "./project-config-manager.ts";
import { DefaultDeploymentManager, DeploymentManager, DeploymentResult } from "./deployment-manager.ts";
import { FunctionScanner, FunctionMetadata } from "./function-scanner.ts";

export interface CLIDeploymentOptions {
  functionName?: string; // If not provided, deploy all functions
  projectRef?: string;   // If not provided, auto-detect from current context
  verify?: boolean;      // Whether to verify deployment after completion
  dryRun?: boolean;      // Whether to perform a dry run without actual deployment
}

export interface CLIDeploymentSummary {
  totalFunctions: number;
  successfulDeployments: number;
  failedDeployments: number;
  results: DeploymentResult[];
  projectRef: string;
  duration: number; // in milliseconds
}

/**
 * Enhanced CLI integration for Edge Functions deployment
 */
export class EnhancedCLI {
  private projectConfigManager: ProjectConfigManager;
  private deploymentManager: DeploymentManager;
  private functionScanner: FunctionScanner;

  constructor(
    projectConfigManager?: ProjectConfigManager,
    deploymentManager?: DeploymentManager,
    functionScanner?: FunctionScanner
  ) {
    this.projectConfigManager = projectConfigManager || new DefaultProjectConfigManager();
    this.deploymentManager = deploymentManager || new DefaultDeploymentManager();
    this.functionScanner = functionScanner || new (class implements FunctionScanner {
      async scanFunctions(rootPath: string): Promise<FunctionMetadata[]> {
        // Basic implementation - in real usage, this would be replaced
        return [];
      }
      validateFunctionStructure(functionPath: string): boolean {
        return true;
      }
      loadEnvironmentVariables(functionPath: string): any {
        return {
          projectLevel: new Map(),
          functionLevel: new Map(),
          merged: new Map(),
          precedenceOrder: []
        };
      }
    })();
  }

  /**
   * Deploy functions with automatic project configuration detection
   * Requirements: 3.1, 3.2, 4.1, 4.2, 4.3
   */
  async deployFunctions(
    functionsPath: string = "supabase/functions",
    options: CLIDeploymentOptions = {}
  ): Promise<CLIDeploymentSummary> {
    const startTime = Date.now();
    
    try {
      console.log("🚀 Starting enhanced Edge Functions deployment...");

      // Step 1: Detect or validate project configuration
      const projectConfig = await this.getProjectConfiguration(options.projectRef);
      if (!projectConfig) {
        throw new Error("Could not detect project configuration. Please run 'supabase link' first.");
      }

      console.log(`📋 Detected project: ${projectConfig.projectRef}`);
      console.log(`🔗 API endpoint: ${projectConfig.apiEndpoint}`);

      // Step 2: Scan for functions
      console.log(`🔍 Scanning for functions in ${functionsPath}...`);
      const allFunctions = await this.functionScanner.scanFunctions(functionsPath);
      
      if (allFunctions.length === 0) {
        console.log("⚠️  No functions found to deploy.");
        return {
          totalFunctions: 0,
          successfulDeployments: 0,
          failedDeployments: 0,
          results: [],
          projectRef: projectConfig.projectRef,
          duration: Date.now() - startTime
        };
      }

      // Step 3: Filter functions based on options
      const functionsToDeployment = this.filterFunctions(allFunctions, options);
      console.log(`📦 Found ${functionsToDeployment.length} function(s) to deploy`);

      // Step 4: Perform dry run if requested
      if (options.dryRun) {
        console.log("🧪 Dry run mode - no actual deployment will occur");
        return this.performDryRun(functionsToDeployment, projectConfig, startTime);
      }

      // Step 5: Deploy functions
      const results: DeploymentResult[] = [];
      let successCount = 0;
      let failCount = 0;

      for (const functionMetadata of functionsToDeployment) {
        console.log(`\n📤 Deploying ${functionMetadata.name}...`);
        
        try {
          const result = await this.deploymentManager.deployFunction(functionMetadata, projectConfig);
          results.push(result);
          
          if (result.success) {
            successCount++;
            console.log(`✅ Successfully deployed ${functionMetadata.name}`);
            if (result.url) {
              console.log(`   URL: ${result.url}`);
            }
          } else {
            failCount++;
            console.log(`❌ Failed to deploy ${functionMetadata.name}: ${result.error}`);
          }
        } catch (error) {
          failCount++;
          const errorResult: DeploymentResult = {
            success: false,
            functionName: functionMetadata.name,
            projectRef: projectConfig.projectRef,
            error: `Deployment error: ${error.message}`
          };
          results.push(errorResult);
          console.log(`❌ Failed to deploy ${functionMetadata.name}: ${error.message}`);
        }
      }

      // Step 6: Verify deployments if requested
      if (options.verify && successCount > 0) {
        console.log("\n🔍 Verifying deployments...");
        await this.verifyDeployments(results.filter(r => r.success), projectConfig);
      }

      // Step 7: Summary
      const duration = Date.now() - startTime;
      console.log(`\n📊 Deployment Summary:`);
      console.log(`   Total functions: ${functionsToDeployment.length}`);
      console.log(`   Successful: ${successCount}`);
      console.log(`   Failed: ${failCount}`);
      console.log(`   Duration: ${duration}ms`);

      return {
        totalFunctions: functionsToDeployment.length,
        successfulDeployments: successCount,
        failedDeployments: failCount,
        results,
        projectRef: projectConfig.projectRef,
        duration
      };

    } catch (error) {
      console.error(`💥 Deployment failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get project configuration, either from options or auto-detection
   */
  private async getProjectConfiguration(projectRef?: string): Promise<ProjectConfig | null> {
    if (projectRef) {
      // Validate provided project reference
      if (!this.projectConfigManager.validateProjectContext(projectRef)) {
        throw new Error(`Invalid project reference: ${projectRef}`);
      }
      
      // Build configuration for specific project
      const apiEndpoint = this.projectConfigManager.resolveApiEndpoint(projectRef);
      const credentials = await this.projectConfigManager.injectCredentials(projectRef);
      
      return {
        projectRef,
        apiEndpoint,
        credentials,
        namespacePrefix: `proj_${projectRef}`,
        isolationLevel: 'strict'
      };
    } else {
      // Auto-detect current project
      return await this.projectConfigManager.detectCurrentProject();
    }
  }

  /**
   * Filter functions based on deployment options
   */
  private filterFunctions(
    allFunctions: FunctionMetadata[],
    options: CLIDeploymentOptions
  ): FunctionMetadata[] {
    if (!options.functionName) {
      return allFunctions;
    }

    // Filter by specific function name
    return allFunctions.filter(func => 
      func.name === options.functionName || 
      func.relativePath === options.functionName
    );
  }

  /**
   * Perform a dry run without actual deployment
   */
  private async performDryRun(
    functions: FunctionMetadata[],
    projectConfig: ProjectConfig,
    startTime: number
  ): Promise<CLIDeploymentSummary> {
    console.log("\n🧪 Dry Run Results:");
    
    const results: DeploymentResult[] = [];
    let successCount = 0;

    for (const func of functions) {
      // Validate deployment target
      const validation = await this.deploymentManager.validateDeploymentTarget(projectConfig.projectRef);
      
      if (validation.isValid) {
        successCount++;
        console.log(`✅ ${func.name} - Ready for deployment`);
        results.push({
          success: true,
          functionName: func.name,
          projectRef: projectConfig.projectRef,
          url: `https://${projectConfig.projectRef}.supabase.co/functions/v1/${func.relativePath}`
        });
      } else {
        console.log(`❌ ${func.name} - Validation failed: ${validation.errors.join(', ')}`);
        results.push({
          success: false,
          functionName: func.name,
          projectRef: projectConfig.projectRef,
          error: validation.errors.join(', ')
        });
      }
    }

    return {
      totalFunctions: functions.length,
      successfulDeployments: successCount,
      failedDeployments: functions.length - successCount,
      results,
      projectRef: projectConfig.projectRef,
      duration: Date.now() - startTime
    };
  }

  /**
   * Verify deployments by checking their status
   */
  private async verifyDeployments(
    successfulResults: DeploymentResult[],
    projectConfig: ProjectConfig
  ): Promise<void> {
    for (const result of successfulResults) {
      try {
        const status = await this.deploymentManager.getDeploymentStatus(
          projectConfig.projectRef,
          result.functionName
        );
        
        if (status.status === 'deployed') {
          console.log(`✅ ${result.functionName} - Verified as deployed`);
        } else {
          console.log(`⚠️  ${result.functionName} - Status: ${status.status}`);
        }
      } catch (error) {
        console.log(`⚠️  ${result.functionName} - Could not verify: ${error.message}`);
      }
    }
  }

  /**
   * List available functions without deploying
   */
  async listFunctions(functionsPath: string = "supabase/functions"): Promise<FunctionMetadata[]> {
    console.log(`🔍 Scanning for functions in ${functionsPath}...`);
    
    const functions = await this.functionScanner.scanFunctions(functionsPath);
    
    if (functions.length === 0) {
      console.log("No functions found.");
    } else {
      console.log(`\nFound ${functions.length} function(s):`);
      functions.forEach(func => {
        console.log(`  📄 ${func.name} (${func.relativePath})`);
        if (func.dependencies.length > 0) {
          console.log(`     Dependencies: ${func.dependencies.map(d => d.targetFunction).join(', ')}`);
        }
      });
    }
    
    return functions;
  }

  /**
   * Show current project configuration
   */
  async showProjectInfo(): Promise<void> {
    console.log("📋 Project Configuration:");
    
    const projectConfig = await this.projectConfigManager.detectCurrentProject();
    
    if (!projectConfig) {
      console.log("❌ No project configuration found. Please run 'supabase link' first.");
      return;
    }

    console.log(`   Project Reference: ${projectConfig.projectRef}`);
    console.log(`   API Endpoint: ${projectConfig.apiEndpoint}`);
    console.log(`   Supabase URL: ${projectConfig.credentials.supabaseUrl}`);
    console.log(`   Namespace Prefix: ${projectConfig.namespacePrefix}`);
    console.log(`   Isolation Level: ${projectConfig.isolationLevel}`);
    
    // Validate project access
    const validation = await this.deploymentManager.validateDeploymentTarget(projectConfig.projectRef);
    if (validation.isValid) {
      console.log("✅ Project configuration is valid");
    } else {
      console.log("❌ Project configuration issues:");
      validation.errors.forEach(error => console.log(`   - ${error}`));
    }
    
    if (validation.warnings.length > 0) {
      console.log("⚠️  Warnings:");
      validation.warnings.forEach(warning => console.log(`   - ${warning}`));
    }
  }
}