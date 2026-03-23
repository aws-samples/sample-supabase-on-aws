/**
 * Edge Functions Configuration Module
 * 
 * Provides configuration validation, error handling, and diagnostic
 * capabilities for Edge Functions in self-hosted environments.
 */

export * from './ConfigurationValidationService'
export * from './ErrorHandlingService'
export * from './StartupValidation'

// Re-export commonly used types and utilities
export type {
  EdgeFunctionsConfig,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ServiceValidationResult,
} from './ConfigurationValidationService'

export type {
  EdgeFunctionsError,
  ErrorContext,
  ErrorCategory,
  ErrorSeverity,
  DiagnosticReport,
  ServiceDiagnostic,
  TroubleshootingGuide,
} from './ErrorHandlingService'

export type {
  StartupValidationResult,
} from './StartupValidation'

// Re-export utility functions
export {
  validateEdgeFunctionsConfiguration,
  getConfigurationDiagnostics,
} from './ConfigurationValidationService'

export {
  handleEdgeFunctionsError,
  generateEdgeFunctionsDiagnostics,
} from './ErrorHandlingService'

export {
  performStartupValidation,
  validateProductionReadiness,
  quickHealthCheck,
  initializeEdgeFunctions,
} from './StartupValidation'