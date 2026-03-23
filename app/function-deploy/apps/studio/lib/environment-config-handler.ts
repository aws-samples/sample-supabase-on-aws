/**
 * Environment Configuration Handler
 * Provides centralized access to environment variables with type safety
 */

export interface EnvironmentConfig {
  // Database configuration
  POSTGRES_HOST: string
  POSTGRES_PORT: string
  POSTGRES_DB: string
  POSTGRES_USER: string
  POSTGRES_PASSWORD: string
  POSTGRES_USER_READ_WRITE: string
  POSTGRES_PASSWORD_READ_WRITE: string
  
  // Platform configuration
  IS_PLATFORM: boolean
  
  // Other configuration
  NODE_ENV: string
}

class EnvironmentConfigHandler {
  private config: Map<string, string | boolean> = new Map()

  constructor() {
    this.loadConfig()
  }

  private loadConfig(): void {
    // Load from process.env
    this.config.set('POSTGRES_HOST', process.env.POSTGRES_HOST || 'localhost')
    this.config.set('POSTGRES_PORT', process.env.POSTGRES_PORT || '5432')
    this.config.set('POSTGRES_DB', process.env.POSTGRES_DB || 'postgres')
    this.config.set('POSTGRES_USER', process.env.POSTGRES_USER || 'postgres')
    this.config.set('POSTGRES_PASSWORD', process.env.POSTGRES_PASSWORD || '')
    this.config.set('POSTGRES_USER_READ_WRITE', process.env.POSTGRES_USER_READ_WRITE || process.env.POSTGRES_USER || 'postgres')
    this.config.set('POSTGRES_PASSWORD_READ_WRITE', process.env.POSTGRES_PASSWORD_READ_WRITE || process.env.POSTGRES_PASSWORD || '')
    this.config.set('IS_PLATFORM', process.env.NEXT_PUBLIC_IS_PLATFORM === 'true')
    this.config.set('NODE_ENV', process.env.NODE_ENV || 'development')
  }

  get(key: keyof EnvironmentConfig): string | boolean {
    const value = this.config.get(key)
    if (value === undefined) {
      throw new Error(`Environment variable ${key} is not defined`)
    }
    return value
  }

  getString(key: keyof EnvironmentConfig): string {
    const value = this.get(key)
    if (typeof value !== 'string') {
      throw new Error(`Environment variable ${key} is not a string`)
    }
    return value
  }

  getBoolean(key: keyof EnvironmentConfig): boolean {
    const value = this.get(key)
    if (typeof value !== 'boolean') {
      throw new Error(`Environment variable ${key} is not a boolean`)
    }
    return value
  }

  has(key: keyof EnvironmentConfig): boolean {
    return this.config.has(key)
  }

  set(key: keyof EnvironmentConfig, value: string | boolean): void {
    this.config.set(key, value)
  }
}

// Singleton instance
let instance: EnvironmentConfigHandler | null = null

export function getEnvironmentConfigHandler(): EnvironmentConfigHandler {
  if (!instance) {
    instance = new EnvironmentConfigHandler()
  }
  return instance
}

export default getEnvironmentConfigHandler
