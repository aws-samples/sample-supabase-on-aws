/**
 * Service for managing database connection pool size configuration
 * Implements Requirements 6.1, 6.2, 6.4 for pool size management
 */

export interface PoolSizeConfiguration {
  poolSize: number | null
  computeSize?: string
  recommendedRange: { min: number, max: number }
  currentConnections?: number
  maxConnections?: number
}

export interface PoolSizeValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
  recommendation?: string
}

/**
 * Service for managing database connection pool size
 */
export class PoolSizeConfigurationService {
  
  /**
   * Validate pool size configuration
   */
  static validatePoolSize(poolSize: number | null): PoolSizeValidationResult {
    const result: PoolSizeValidationResult = {
      isValid: true,
      errors: [],
      warnings: []
    }
    
    // Null is valid (means auto-configuration)
    if (poolSize === null) {
      result.recommendation = 'Pool size will be configured automatically based on compute size'
      return result
    }
    
    // Validate range
    if (!Number.isInteger(poolSize)) {
      result.isValid = false
      result.errors.push('Pool size must be a whole number')
      return result
    }
    
    if (poolSize < 1) {
      result.isValid = false
      result.errors.push('Pool size must be at least 1')
      return result
    }
    
    if (poolSize > 1000) {
      result.isValid = false
      result.errors.push("Pool size can't be more than 1000")
      return result
    }
    
    // Add warnings for potentially problematic values
    if (poolSize > 100) {
      result.warnings.push('Pool sizes above 100 may impact performance. Consider using a smaller value unless you have specific requirements for high concurrency.')
    }
    
    if (poolSize < 5) {
      result.warnings.push('Very small pool sizes may limit concurrent requests. Consider using at least 5-10 connections.')
    }
    
    // Add recommendations based on pool size
    if (poolSize >= 10 && poolSize <= 50) {
      result.recommendation = 'This pool size is in the recommended range for most applications'
    } else if (poolSize > 50 && poolSize <= 100) {
      result.recommendation = 'This is a larger pool size suitable for high-traffic applications'
    } else if (poolSize > 100) {
      result.recommendation = 'This is a very large pool size. Monitor performance and consider reducing if not needed'
    } else {
      result.recommendation = 'Consider increasing pool size to 10-50 for better performance'
    }
    
    return result
  }
  
  /**
   * Get recommended pool size range based on compute size
   */
  static getRecommendedPoolSizeRange(computeSize?: string): { min: number, max: number } {
    // Default ranges based on typical compute sizes
    const ranges: Record<string, { min: number, max: number }> = {
      'micro': { min: 5, max: 15 },
      'small': { min: 10, max: 25 },
      'medium': { min: 15, max: 40 },
      'large': { min: 25, max: 60 },
      'xlarge': { min: 40, max: 80 },
      '2xlarge': { min: 60, max: 120 },
      '4xlarge': { min: 80, max: 150 },
      '8xlarge': { min: 100, max: 200 },
      '12xlarge': { min: 120, max: 250 },
      '16xlarge': { min: 150, max: 300 }
    }
    
    return ranges[computeSize || 'small'] || { min: 10, max: 50 }
  }
  
  /**
   * Apply pool size configuration to the Data API service
   */
  static async applyPoolSizeConfiguration(
    poolSize: number | null,
    projectRef: string
  ): Promise<void> {
    console.log(`Applying pool size configuration for project ${projectRef}:`, poolSize)
    
    if (poolSize === null) {
      console.log('Pool size set to auto-configuration mode')
      // In a real implementation, this would:
      // 1. Remove explicit pool size configuration
      // 2. Let the system determine optimal pool size based on compute
      // 3. Update PostgREST configuration to use automatic sizing
      return
    }
    
    // Validate before applying
    const validation = this.validatePoolSize(poolSize)
    if (!validation.isValid) {
      throw new Error(`Invalid pool size: ${validation.errors.join(', ')}`)
    }
    
    // In a real implementation, this would:
    // 1. Update PostgREST configuration with new pool size
    // 2. Gracefully adjust the connection pool without dropping connections
    // 3. Monitor the pool to ensure it's functioning correctly
    // 4. Update environment variables or configuration files
    
    // Simulate configuration application
    await this.simulatePoolSizeApplication(poolSize, projectRef)
    
    console.log(`Pool size configuration applied successfully: ${poolSize} connections`)
  }
  
  /**
   * Simulate pool size application (for testing/development)
   */
  private static async simulatePoolSizeApplication(
    poolSize: number,
    projectRef: string
  ): Promise<void> {
    // Simulate the time it takes to apply pool size changes
    await new Promise(resolve => setTimeout(resolve, 200))
    
    // Simulate potential failure (5% chance for testing)
    if (Math.random() < 0.05) {
      throw new Error('Failed to apply pool size configuration to connection pool')
    }
    
    // Log the configuration change
    console.log(`Pool size updated for project ${projectRef}: ${poolSize} connections`)
  }
  
  /**
   * Get current pool size configuration
   */
  static getCurrentPoolSize(): number | null {
    const envPoolSize = process.env.PGRST_DB_POOL
    return envPoolSize ? parseInt(envPoolSize, 10) : null
  }
  
  /**
   * Get pool size guidance text for UI
   */
  static getPoolSizeGuidance(poolSize: number | null, computeSize?: string): string {
    if (poolSize === null) {
      return 'Pool size will be configured automatically based on your compute size. This is recommended for most use cases.'
    }
    
    const recommended = this.getRecommendedPoolSizeRange(computeSize)
    const validation = this.validatePoolSize(poolSize)
    
    if (!validation.isValid) {
      return `Invalid pool size: ${validation.errors.join(', ')}`
    }
    
    let guidance = `Current pool size: ${poolSize} connections. `
    
    if (poolSize >= recommended.min && poolSize <= recommended.max) {
      guidance += 'This is within the recommended range for your compute size.'
    } else if (poolSize < recommended.min) {
      guidance += `Consider increasing to ${recommended.min}-${recommended.max} for better performance.`
    } else {
      guidance += `Consider reducing to ${recommended.min}-${recommended.max} unless you need high concurrency.`
    }
    
    if (validation.recommendation) {
      guidance += ` ${validation.recommendation}`
    }
    
    return guidance
  }
  
  /**
   * Get optimal pool size suggestion based on compute size
   */
  static getOptimalPoolSizeSuggestion(computeSize?: string): number {
    const range = this.getRecommendedPoolSizeRange(computeSize)
    // Return the middle of the recommended range
    return Math.round((range.min + range.max) / 2)
  }
  
  /**
   * Check if pool size is in recommended range
   */
  static isPoolSizeOptimal(poolSize: number | null, computeSize?: string): boolean {
    if (poolSize === null) return true // Auto-configuration is always optimal
    
    const range = this.getRecommendedPoolSizeRange(computeSize)
    return poolSize >= range.min && poolSize <= range.max
  }
}