/**
 * Base HTTP client for external service integrations
 * Provides retry logic, timeout, and structured error handling
 */

export interface BaseClientConfig {
  baseUrl: string
  authToken?: string
  timeout?: number
  retries?: number
  retryDelay?: number
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  headers?: Record<string, string>
}

export class BaseClient {
  protected readonly baseUrl: string
  protected readonly authToken: string | undefined
  protected readonly timeout: number
  protected readonly retries: number
  protected readonly retryDelay: number

  constructor(config: BaseClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.authToken = config.authToken
    this.timeout = config.timeout ?? 10000
    this.retries = config.retries ?? 2
    this.retryDelay = config.retryDelay ?? 500
  }

  protected async request<T = unknown>(options: RequestOptions): Promise<{
    ok: boolean
    status: number
    data?: T
    error?: string
  }> {
    const url = `${this.baseUrl}${options.path}`
    const headers: Record<string, string> = {
      ...options.headers,
    }

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`
    }

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), this.timeout)

        const response = await fetch(url, {
          method: options.method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (response.ok) {
          // Handle 204 No Content
          if (response.status === 204) {
            return { ok: true, status: response.status }
          }
          const data = (await response.json()) as T
          return { ok: true, status: response.status, data }
        }

        // Non-retryable client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          const errorText = await response.text()
          return { ok: false, status: response.status, error: errorText }
        }

        // Server errors (5xx) - may retry
        const errorText = await response.text()
        lastError = new Error(`HTTP ${response.status}: ${errorText}`)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }

      // Wait before retry (skip delay on last attempt)
      if (attempt < this.retries) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelay * (attempt + 1)))
      }
    }

    return {
      ok: false,
      status: 0,
      error: lastError?.message || 'Unknown error',
    }
  }
}
