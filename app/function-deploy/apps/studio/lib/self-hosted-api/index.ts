/**
 * Self-hosted API utilities and types
 * Provides data access layers and utilities for self-hosted Supabase environments
 */

// Export types
export type * from './types'

// Export token utilities
export {
  generateAccessToken,
  hashToken,
  validateTokenName,
  validateTokenExpiration,
  isTokenExpired,
  createAccessTokenRecord,
  tokenRecordToResponse,
  validateSecretName,
  validateSecretValue,
} from './token-utils'

// Export storage classes and instances
export {
  AccessTokenStorage,
  ProjectSecretsStorage,
  accessTokenStorage,
  projectSecretsStorage,
} from './storage'

// Export environment utilities
export {
  isSelfHosted,
  getStorageBasePath,
  getEncryptionKey,
} from './environment'