/**
 * Service Discovery
 * 
 * Discovers and validates local services in self-hosted environments.
 * Provides health checking and endpoint resolution for Edge Functions.
 */

export interface ServiceEndpoint {
  url: string
  healthy: boolean
  version?: string
  error?: string
}

interface ServiceCache {
  endpoint: ServiceEndpoint
  timestamp: number
}

class ServiceDiscovery {
  private cache: Map<string, ServiceCache> = new Map()
  private readonly CACHE_TTL = 30000 // 30 seconds

  /**
   * Discover Edge Functions service endpoint
   */
  async discoverEdgeFunctions(): Promise<ServiceEndpoint> {
    const cacheKey = 'edge-functions'
    const cached = this.getFromCache(cacheKey)
    
    if (cached) {
      return cached
    }

    // Try to discover the Edge Functions service
    const endpoint = await this.probeEdgeFunctionsService()
    
    // Cache the result
    this.setCache(cacheKey, endpoint)
    
    return endpoint
  }

  /**
   * Probe the Edge Functions service to check availability
   */
  private async probeEdgeFunctionsService(): Promise<ServiceEndpoint> {
    // Get the Edge Functions URL from environment or use default
    const edgeFunctionsUrl = 
      process.env.EDGE_FUNCTIONS_URL || 
      process.env.SUPABASE_PUBLIC_URL || 
      'http://localhost:8000'

    const endpoint = `${edgeFunctionsUrl}/functions/v1`

    try {
      // Try to reach the health endpoint
      const healthUrl = `${edgeFunctionsUrl}/functions/v1/health`
      
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      })

      if (response.ok) {
        const data = await response.json().catch(() => ({}))
        
        return {
          url: endpoint,
          healthy: true,
          version: data.version,
        }
      }

      return {
        url: endpoint,
        healthy: false,
        error: `Service returned status ${response.status}`,
      }
    } catch (error) {
      // Service is not reachable
      return {
        url: endpoint,
        healthy: false,
        error: error instanceof Error ? error.message : 'Service unreachable',
      }
    }
  }

  /**
   * Get cached service endpoint if still valid
   */
  private getFromCache(key: string): ServiceEndpoint | null {
    const cached = this.cache.get(key)
    
    if (!cached) {
      return null
    }

    const now = Date.now()
    const age = now - cached.timestamp

    if (age > this.CACHE_TTL) {
      this.cache.delete(key)
      return null
    }

    return cached.endpoint
  }

  /**
   * Store service endpoint in cache
   */
  private setCache(key: string, endpoint: ServiceEndpoint): void {
    this.cache.set(key, {
      endpoint,
      timestamp: Date.now(),
    })
  }

  /**
   * Clear all cached service endpoints
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Get diagnostic information
   */
  getDiagnosticInfo(): Record<string, any> {
    const cacheEntries: Record<string, any> = {}
    
    this.cache.forEach((value, key) => {
      cacheEntries[key] = {
        ...value.endpoint,
        age: Date.now() - value.timestamp,
      }
    })

    return {
      cacheSize: this.cache.size,
      cacheTTL: this.CACHE_TTL,
      entries: cacheEntries,
    }
  }
}

// Singleton instance
export const serviceDiscovery = new ServiceDiscovery()
