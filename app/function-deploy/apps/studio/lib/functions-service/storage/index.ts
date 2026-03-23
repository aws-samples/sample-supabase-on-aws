// Storage Backend Interface and Types
export {
  type StorageBackend,
  type FunctionFile,
  type FunctionMetadata,
  type StorageHealthStatus,
  type StorageBackendConfig,
  StorageBackendError,
  StorageNotFoundError,
  StorageAccessError,
  StorageConfigurationError,
} from './StorageBackend'

// Storage Backend Implementations
export { LocalFileSystemStorage } from './LocalFileSystemStorage'
export { S3Storage, type S3StorageConfig } from './S3Storage'

// Storage Backend Factory
export {
  StorageBackendFactory,
  getStorageBackend,
  validateStorageConfiguration,
  getStorageConfigurationSummary,
  refreshStorageBackend,
} from './StorageBackendFactory'