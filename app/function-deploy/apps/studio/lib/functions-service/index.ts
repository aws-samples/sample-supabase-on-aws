export {
  FunctionsServiceAdapter,
  getFunctionsServiceAdapter,
  resetFunctionsServiceAdapter,
} from './FunctionsServiceAdapter'

export type {
  FunctionMetadata,
  DeployFunctionOptions,
  InvokeFunctionOptions,
  FunctionInvocationResponse,
} from './FunctionsServiceAdapter'

// Edge Functions Client exports
export {
  EdgeFunctionsClient,
  getEdgeFunctionsClient,
  resetEdgeFunctionsClient,
} from './EdgeFunctionsClient'

export type {
  DeploymentData,
  DeploymentResult,
  FunctionInfo,
  InvocationResult,
} from './EdgeFunctionsClient'

// Storage Backend exports
export * from './storage'

// CORS exports
export * from './cors'

// Lazy Loading exports
export * from './lazy-loading'
