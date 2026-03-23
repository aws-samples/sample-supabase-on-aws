/**
 * API request/response types
 */

// API Response types
export interface ApiSuccessResponse<T> {
  data: T
  error?: never
}

export interface ApiErrorResponse {
  data?: never
  error: {
    message: string
    code?: string
    details?: unknown
  }
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse

// Service result type for internal operations
export interface ServiceResult<T = void> {
  success: boolean
  data?: T
  error?: string
}

// Pagination types
export interface PaginationParams {
  page?: number
  limit?: number
}

export interface PaginatedResponse<T> {
  data: T[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

// Sort options for projects
export type SortOption = 'name_asc' | 'name_desc' | 'created_asc' | 'created_desc'

// Query parameters for listing projects
export interface ListProjectsParams extends PaginationParams {
  status?: string
  region?: string
  db_instance_id?: number
  sort?: SortOption
  search?: string
  statuses?: string
}

// Query parameters for listing RDS instances
export interface ListRdsInstancesParams extends PaginationParams {
  status?: string
  region?: string
}
