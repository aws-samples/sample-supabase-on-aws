/**
 * CORS Module for Edge Functions
 * 
 * Exports all CORS-related functionality for Edge Functions service.
 */

export {
  CORSConfig,
  CORSError,
  CORSConfigurationService,
  EdgeFunctionsCORSService,
  getCORSService,
  resetCORSService,
  createCORSError,
} from './CORSConfigurationService'

export {
  CORSMiddlewareOptions,
  withCORS,
  handleCORSPreflight,
  addCORSHeaders,
  validateCORSRequest,
  getCORSDiagnostics,
} from './CORSMiddleware'