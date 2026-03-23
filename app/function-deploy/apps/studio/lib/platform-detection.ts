/**
 * Platform Detection Service
 * 
 * Determines deployment environment and enables appropriate features.
 * Provides service discovery for local Edge Functions container.
 */

import { IS_PLATFORM } from './constants'
import { serviceDiscovery, type ServiceEndpoint } from './service-discovery'

export interface ServiceStatus {
  available: boolean
  endpoint: string
  version?: string
  error?: string
}

export interface PlatformDetectionService {
  isPlatform(): boolean
  isEdgeFunctionsEnabled(): boolean
  getEdgeFunctionsEndpoint(): string
  validateLocalServices(): Promise<ServiceStatus>
}

class PlatformDetectionServiceImpl implements PlatformDetectionService {
  private edgeFunctionsEndpoint: string

  constructor() {
    // For self-hosted environments, use Kong proxy endpoint to avoid CORS issues
    if (this.isPlatform()) {
      // Platform environments use the standard API
      this.edgeFunctionsEndpoint = '/api/v1'
    } else {
      // Self-hosted environments use Kong proxy
      const publicUrl = process.env.SUPABASE_PUBLIC_URL || 'http://localhost:8000'
      this.edgeFunctionsEndpoint = `${publicUrl}/functions/v1`
    }
  }

  isPlatform(): boolean {
    return IS_PLATFORM
  }

  isEdgeFunctionsEnabled(): boolean {
    // Edge Functions are always enabled - platform detection determines the endpoint
    return true
  }

  getEdgeFunctionsEndpoint(): string {
    return this.edgeFunctionsEndpoint
  }

  async validateLocalServices(): Promise<ServiceStatus> {
    // For platform environments, assume services are available
    if (this.isPlatform()) {
      return {
        available: true,
        endpoint: this.edgeFunctionsEndpoint,
      }
    }

    // For self-hosted environments, use service discovery
    try {
      const edgeFunctionsService = await serviceDiscovery.discoverEdgeFunctions()
      
      return {
        available: edgeFunctionsService.healthy,
        endpoint: edgeFunctionsService.url,
        version: edgeFunctionsService.version,
        error: edgeFunctionsService.error,
      }
    } catch (error) {
      return {
        available: false,
        endpoint: this.edgeFunctionsEndpoint,
        error: error instanceof Error ? error.message : 'Service discovery failed',
      }
    }
  }

  /**
   * Clear the service status cache
   */
  clearCache(): void {
    serviceDiscovery.clearCache()
  }

  /**
   * Get diagnostic information for troubleshooting
   */
  getDiagnosticInfo(): Record<string, any> {
    return {
      isPlatform: this.isPlatform(),
      edgeFunctionsEndpoint: this.edgeFunctionsEndpoint,
      environmentVariables: {
        EDGE_FUNCTIONS_URL: process.env.EDGE_FUNCTIONS_URL,
        NEXT_PUBLIC_IS_PLATFORM: process.env.NEXT_PUBLIC_IS_PLATFORM,
      },
      serviceDiscovery: serviceDiscovery.getDiagnosticInfo(),
    }
  }
}

// Singleton instance
export const platformDetectionService = new PlatformDetectionServiceImpl()

/**
 * Hook for React components to use platform detection
 */
export function usePlatformDetection() {
  return {
    isPlatform: platformDetectionService.isPlatform(),
    isEdgeFunctionsEnabled: platformDetectionService.isEdgeFunctionsEnabled(),
    edgeFunctionsEndpoint: platformDetectionService.getEdgeFunctionsEndpoint(),
    validateLocalServices: () => platformDetectionService.validateLocalServices(),
    getDiagnosticInfo: () => platformDetectionService.getDiagnosticInfo(),
  }
}

/**
 * Utility function to check if Edge Functions service is available
 */
export async function checkEdgeFunctionsAvailability(): Promise<ServiceStatus> {
  return platformDetectionService.validateLocalServices()
}