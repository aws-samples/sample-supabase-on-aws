/**
 * Project Configuration Manager
 * 
 * Handles automatic project context detection, API endpoint resolution,
 * and credential injection for CLI operations.
 * 
 * Requirements: 3.1, 4.1, 4.2
 */

export interface ProjectCredentials {
  serviceRoleKey: string;
  anonKey: string;
  supabaseUrl: string;
}

export interface ProjectConfig {
  projectRef: string;
  apiEndpoint: string;
  credentials: ProjectCredentials;
  namespacePrefix: string;
  isolationLevel: 'strict' | 'permissive';
}

export interface ProjectConfigManager {
  detectCurrentProject(): Promise<ProjectConfig | null>;
  resolveApiEndpoint(projectRef: string): string;
  injectCredentials(projectRef: string): Promise<ProjectCredentials>;
  validateProjectContext(projectRef: string): boolean;
}

/**
 * Default implementation of ProjectConfigManager
 */
export class DefaultProjectConfigManager implements ProjectConfigManager {
  private configCache = new Map<string, ProjectConfig>();
  private readonly baseApiUrl: string;

  constructor(baseApiUrl: string = 'https://api.supabase.com') {
    this.baseApiUrl = baseApiUrl;
  }

  /**
   * Automatically detect current project context from CLI configuration
   * Requirements: 3.1, 4.1
   */
  async detectCurrentProject(): Promise<ProjectConfig | null> {
    try {
      // Try to read project configuration from various sources
      const projectRef = await this.getCurrentProjectRef();
      
      if (!projectRef) {
        console.warn('No project reference found. Please link to a project using: supabase link');
        return null;
      }

      // Check cache first
      if (this.configCache.has(projectRef)) {
        return this.configCache.get(projectRef)!;
      }

      // Build project configuration
      const config: ProjectConfig = {
        projectRef,
        apiEndpoint: this.resolveApiEndpoint(projectRef),
        credentials: await this.injectCredentials(projectRef),
        namespacePrefix: `proj_${projectRef}`,
        isolationLevel: 'strict'
      };

      // Cache the configuration
      this.configCache.set(projectRef, config);
      
      console.log(`Detected project context: ${projectRef}`);
      return config;
    } catch (error) {
      console.error('Failed to detect project context:', error);
      return null;
    }
  }

  /**
   * Resolve project-specific API endpoint
   * Requirements: 4.2
   */
  resolveApiEndpoint(projectRef: string): string {
    if (!projectRef || typeof projectRef !== 'string') {
      throw new Error('Project reference must be a non-empty string');
    }

    // Return the project-specific functions deployment endpoint
    return `${this.baseApiUrl}/v1/projects/${projectRef}/functions/deploy`;
  }

  /**
   * Inject project-specific credentials automatically
   * Requirements: 4.1, 4.2
   */
  async injectCredentials(projectRef: string): Promise<ProjectCredentials> {
    if (!projectRef || typeof projectRef !== 'string') {
      throw new Error('Project reference must be a non-empty string');
    }

    try {
      // In a real implementation, this would read from:
      // 1. Environment variables
      // 2. CLI configuration files
      // 3. Supabase project settings
      
      // Convert project ref to environment variable format (replace hyphens with underscores)
      const envProjectRef = projectRef.toUpperCase().replace(/-/g, '_');
      
      const credentials: ProjectCredentials = {
        serviceRoleKey: await this.getEnvironmentVariable(`SUPABASE_SERVICE_ROLE_KEY_${envProjectRef}`) ||
                      await this.getEnvironmentVariable('SUPABASE_SERVICE_ROLE_KEY') ||
                      '',
        anonKey: await this.getEnvironmentVariable(`SUPABASE_ANON_KEY_${envProjectRef}`) ||
                await this.getEnvironmentVariable('SUPABASE_ANON_KEY') ||
                '',
        supabaseUrl: await this.getEnvironmentVariable(`SUPABASE_URL_${envProjectRef}`) ||
                    await this.getEnvironmentVariable('SUPABASE_URL') ||
                    `https://${projectRef}.supabase.co`
      };

      // Validate that we have the required credentials
      if (!credentials.serviceRoleKey) {
        throw new Error(`Missing service role key for project ${projectRef}`);
      }

      return credentials;
    } catch (error) {
      throw new Error(`Failed to inject credentials for project ${projectRef}: ${error}`);
    }
  }

  /**
   * Validate project context and configuration
   * Requirements: 3.1
   */
  validateProjectContext(projectRef: string): boolean {
    if (!projectRef || typeof projectRef !== 'string') {
      return false;
    }

    // Validate project reference format (basic validation)
    const projectRefPattern = /^[a-zA-Z0-9][a-zA-Z0-9-_]*[a-zA-Z0-9]$/;
    if (!projectRefPattern.test(projectRef)) {
      console.error(`Invalid project reference format: ${projectRef}`);
      return false;
    }

    return true;
  }

  /**
   * Get current project reference from CLI configuration
   * This would typically read from .supabase/config.toml or similar
   */
  private async getCurrentProjectRef(): Promise<string | null> {
    try {
      // Try multiple sources for project reference
      
      // 1. Environment variable
      const envProjectRef = await this.getEnvironmentVariable('SUPABASE_PROJECT_REF');
      if (envProjectRef) {
        return envProjectRef;
      }

      // 2. CLI configuration file (simulated)
      const configProjectRef = await this.readProjectRefFromConfig();
      if (configProjectRef) {
        return configProjectRef;
      }

      // 3. Current working directory context (simulated)
      const contextProjectRef = await this.inferProjectRefFromContext();
      if (contextProjectRef) {
        return contextProjectRef;
      }

      return null;
    } catch (error) {
      console.error('Error getting current project reference:', error);
      return null;
    }
  }

  /**
   * Get environment variable value
   */
  protected async getEnvironmentVariable(name: string): Promise<string | undefined> {
    return Deno.env.get(name);
  }

  /**
   * Read project reference from CLI configuration file
   * In a real implementation, this would parse .supabase/config.toml
   */
  protected async readProjectRefFromConfig(): Promise<string | null> {
    try {
      // Simulate reading from .supabase/config.toml
      // In reality, this would use a TOML parser
      const configPath = '.supabase/config.toml';
      
      try {
        const configContent = await Deno.readTextFile(configPath);
        
        // Simple regex to extract project_id (in real implementation, use proper TOML parser)
        const projectIdMatch = configContent.match(/project_id\s*=\s*"([^"]+)"/);
        if (projectIdMatch) {
          return projectIdMatch[1];
        }
      } catch {
        // Config file doesn't exist or can't be read
        return null;
      }

      return null;
    } catch (error) {
      console.error('Error reading project config:', error);
      return null;
    }
  }

  /**
   * Infer project reference from current context
   * This could look at directory structure, git remotes, etc.
   */
  protected async inferProjectRefFromContext(): Promise<string | null> {
    try {
      // In a real implementation, this might:
      // 1. Check git remote URLs for Supabase project references
      // 2. Look for project-specific files or directories
      // 3. Check parent directories for configuration
      
      // For now, return null (no context-based inference)
      return null;
    } catch (error) {
      console.error('Error inferring project context:', error);
      return null;
    }
  }

  /**
   * Clear configuration cache (useful for testing or when switching projects)
   */
  clearCache(): void {
    this.configCache.clear();
  }

  /**
   * Update cached configuration for a project
   */
  updateCachedConfig(projectRef: string, config: Partial<ProjectConfig>): void {
    const existing = this.configCache.get(projectRef);
    if (existing) {
      this.configCache.set(projectRef, { ...existing, ...config });
    }
  }
}