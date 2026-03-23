// Deno type definitions for Edge Functions main router

declare global {
  const EdgeRuntime: {
    userWorkers: {
      create(options: {
        servicePath: string
        memoryLimitMb: number
        workerTimeoutMs: number
        noModuleCache: boolean
        importMapPath: string | null
        envVars: [string, string][]
      }): Promise<{
        fetch(req: Request): Promise<Response>
      }>
    }
  }

  const Deno: {
    env: {
      get(key: string): string | undefined
      toObject(): Record<string, string>
    }
    stat(path: string): Promise<{
      isFile: boolean
      isDirectory: boolean
    }>
  }
}

export {}
