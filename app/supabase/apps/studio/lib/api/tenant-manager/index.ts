/**
 * Tenant-Manager API client exports
 */

export { tenantManagerFetch } from './client'
export type { TenantManagerError, TenantManagerResponse } from './client'

export {
  listProjects,
  getProject,
  provisionProject,
  deprovisionProject,
  listProjectsByOrganization,
} from './projects'
export type { Project } from './projects'

export {
  listAPIKeys,
  createAPIKey,
  getAPIKey,
  deleteAPIKey,
} from './api-keys'
export type { StudioAPIKey } from './api-keys'

export {
  listJWTKeys,
  createStandbyKey,
  rotateKeys,
} from './jwt-keys'
export type { StudioSigningKey } from './jwt-keys'
