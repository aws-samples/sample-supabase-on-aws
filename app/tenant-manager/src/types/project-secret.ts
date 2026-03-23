/**
 * Project secret document structure for AWS Secrets Manager
 * Each project has one secret containing database config, JWT keys, and API keys
 */

import type { JwtKey } from './jwt-key.js'
import type { ApiKey } from './api-key.js'

export interface ProjectDatabase {
  DB_URI: string
  DB_SCHEMAS: string
  DB_ANON_ROLE: string
  DB_USE_LEGACY_GUCS: string
}

export interface ProjectSecretDocument {
  version: number
  project_ref: string
  database: ProjectDatabase
  jwt_keys: JwtKey[]
  api_keys: ApiKey[]
}
