/**
 * Tenant-Manager HTTP Client
 * Handles all communication with the Tenant-Manager service
 */

const TENANT_MANAGER_URL = process.env.TENANT_MANAGER_URL || 'http://localhost:3001'
const TENANT_MANAGER_API_KEY = process.env.TENANT_MANAGER_API_KEY || ''

export interface TenantManagerError {
  message: string
  code?: string
  statusCode: number
}

export interface TenantManagerResponse<T> {
  data?: T
  error?: TenantManagerError
}

/**
 * Make a request to the Tenant-Manager service
 */
export async function tenantManagerFetch<T>(
  path: string,
  options?: RequestInit
): Promise<TenantManagerResponse<T>> {
  try {
    const response = await fetch(`${TENANT_MANAGER_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(TENANT_MANAGER_API_KEY && { Authorization: `Bearer ${TENANT_MANAGER_API_KEY}` }),
        ...options?.headers,
      },
    })

    // Handle 204 No Content responses
    if (response.status === 204) {
      return { data: undefined }
    }

    const json = await response.json()

    if (!response.ok) {
      return {
        error: {
          message: json.error?.message || json.message || 'Request failed',
          code: json.error?.code,
          statusCode: response.status,
        },
      }
    }

    // Tenant-Manager wraps responses in { data: ... }
    return { data: json.data !== undefined ? json.data : json }
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : 'Network error',
        code: 'NETWORK_ERROR',
        statusCode: 0,
      },
    }
  }
}
