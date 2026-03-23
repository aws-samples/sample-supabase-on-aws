export interface ContainerStatus {
  name: string
  status: 'running' | 'stopped' | 'error'
  health: 'healthy' | 'unhealthy' | 'starting' | 'none'
  uptime: string
  ports: Array<{ host: number; container: number }>
  containerId?: string
  image?: string
  created?: string
  restartCount?: number
}

export interface DockerAPIResponse {
  Id: string
  Names: string[]
  Image: string
  State: string
  Status: string
  Created: number
  Ports: Array<{
    PrivatePort: number
    PublicPort?: number
    Type: string
  }>
  Labels?: Record<string, string>
}

export interface HealthCheckResult {
  healthy: boolean
  message: string
  responseTime?: number
  lastChecked: string
}

export class DockerContainerService {
  private healthCheckCache = new Map<string, { result: HealthCheckResult; timestamp: number }>()
  private readonly HEALTH_CACHE_TTL = 30000 // 30 seconds

  /**
   * Get the status of a Docker container using Docker API
   */
  async getContainerStatus(containerName: string): Promise<ContainerStatus> {
    try {
      // First try Docker API if available
      const dockerStatus = await this.getDockerContainerInfo(containerName)
      if (dockerStatus) {
        return dockerStatus
      }

      // Fallback to service-based checking
      const isRunning = await this.checkContainerRunning(containerName)
      const health = await this.getContainerHealth(containerName)
      
      return {
        name: containerName,
        status: isRunning ? 'running' : 'stopped',
        health: health.healthy ? 'healthy' : 'unhealthy',
        uptime: isRunning ? 'unknown' : '0',
        ports: this.getDefaultPorts(containerName),
      }
    } catch (error) {
      console.error(`Error checking container status for ${containerName}:`, error)
      return {
        name: containerName,
        status: 'error',
        health: 'none',
        uptime: '0',
        ports: [],
      }
    }
  }

  /**
   * Get container information from Docker API
   */
  private async getDockerContainerInfo(containerName: string): Promise<ContainerStatus | null> {
    try {
      // Check if Docker socket is available (Unix socket or named pipe on Windows)
      const dockerSocketPath = process.platform === 'win32' 
        ? '\\\\.\\pipe\\docker_engine' 
        : '/var/run/docker.sock'

      // For security and simplicity, we'll use docker CLI if available
      // In production, you might want to use the Docker API directly
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(exec)

      try {
        const { stdout } = await execAsync(
          `docker ps --filter "name=${containerName}" --format "{{json .}}"`,
          { timeout: 5000 }
        )

        if (!stdout.trim()) {
          // Container not found in running containers, check all containers
          const { stdout: allContainers } = await execAsync(
            `docker ps -a --filter "name=${containerName}" --format "{{json .}}"`,
            { timeout: 5000 }
          )

          if (!allContainers.trim()) {
            return null // Container doesn't exist
          }

          // Parse stopped container info
          const containerInfo = JSON.parse(allContainers.trim().split('\n')[0])
          return this.parseDockerContainerInfo(containerInfo, containerName, false)
        }

        // Parse running container info
        const containerInfo = JSON.parse(stdout.trim().split('\n')[0])
        return this.parseDockerContainerInfo(containerInfo, containerName, true)

      } catch (dockerError) {
        console.warn('Docker CLI not available, falling back to service checks:', dockerError)
        return null
      }
    } catch (error) {
      console.warn('Docker API integration failed:', error)
      return null
    }
  }

  /**
   * Parse Docker container information from CLI output
   */
  private parseDockerContainerInfo(
    containerInfo: any, 
    containerName: string, 
    isRunning: boolean
  ): ContainerStatus {
    const ports = this.parseDockerPorts(containerInfo.Ports || '')
    const uptime = this.parseDockerUptime(containerInfo.Status || '')
    
    return {
      name: containerName,
      status: isRunning ? 'running' : 'stopped',
      health: isRunning ? 'starting' : 'none', // Will be updated by health check
      uptime,
      ports: ports.length > 0 ? ports : this.getDefaultPorts(containerName),
      containerId: containerInfo.ID || containerInfo.Id,
      image: containerInfo.Image,
      created: containerInfo.CreatedAt,
    }
  }

  /**
   * Parse Docker port mappings from status string
   */
  private parseDockerPorts(portsString: string): Array<{ host: number; container: number }> {
    const ports: Array<{ host: number; container: number }> = []
    
    // Parse port mappings like "0.0.0.0:6543->6543/tcp, 0.0.0.0:4000->4000/tcp"
    const portMappings = portsString.split(',').map(p => p.trim())
    
    for (const mapping of portMappings) {
      const match = mapping.match(/(\d+)->(\d+)/)
      if (match) {
        ports.push({
          host: parseInt(match[1], 10),
          container: parseInt(match[2], 10)
        })
      }
    }
    
    return ports
  }

  /**
   * Parse Docker uptime from status string
   */
  private parseDockerUptime(statusString: string): string {
    // Parse status like "Up 2 hours" or "Exited (0) 5 minutes ago"
    const upMatch = statusString.match(/Up (.+)/)
    if (upMatch) {
      return upMatch[1]
    }
    
    const exitMatch = statusString.match(/Exited \((\d+)\) (.+) ago/)
    if (exitMatch) {
      return `Stopped ${exitMatch[2]} ago (exit code ${exitMatch[1]})`
    }
    
    return statusString || 'unknown'
  }

  /**
   * Get container health status with caching
   */
  async getContainerHealth(containerName: string): Promise<HealthCheckResult> {
    const cacheKey = `health_${containerName}`
    const cached = this.healthCheckCache.get(cacheKey)
    
    if (cached && Date.now() - cached.timestamp < this.HEALTH_CACHE_TTL) {
      return cached.result
    }

    const result = await this.performHealthCheck(containerName)
    this.healthCheckCache.set(cacheKey, { result, timestamp: Date.now() })
    
    return result
  }

  /**
   * Perform health check for a specific container
   */
  private async performHealthCheck(containerName: string): Promise<HealthCheckResult> {
    const startTime = Date.now()
    
    try {
      switch (containerName) {
        case 'supabase-edge-functions':
        case 'functions':
        case 'edge-functions':
          return await this.checkEdgeFunctionsHealth()
        case 'supavisor':
          return await this.checkSupavisorHealth()
        case 'postgres':
        case 'db':
          return await this.checkPostgresHealth()
        case 'kong':
          return await this.checkKongHealth()
        case 'gotrue':
          return await this.checkGoTrueHealth()
        case 'postgrest':
          return await this.checkPostgRESTHealth()
        case 'realtime':
          return await this.checkRealtimeHealth()
        case 'storage':
          return await this.checkStorageHealth()
        default:
          return {
            healthy: false,
            message: `Health check not implemented for ${containerName}`,
            lastChecked: new Date().toISOString()
          }
      }
    } catch (error) {
      return {
        healthy: false,
        message: `Health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      }
    }
  }

  /**
   * Check if a container is running by attempting to connect to its service
   */
  private async checkContainerRunning(containerName: string): Promise<boolean> {
    try {
      const health = await this.getContainerHealth(containerName)
      return health.healthy
    } catch (error) {
      console.error(`Error checking if ${containerName} is running:`, error)
      return false
    }
  }

  /**
   * Check Supavisor health via management port
   */
  private async checkSupavisorHealth(): Promise<HealthCheckResult> {
    const startTime = Date.now()
    const managementPort = parseInt(process.env.SUPAVISOR_MANAGEMENT_PORT || '4000', 10)
    
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      
      try {
        const response = await fetch(`http://localhost:${managementPort}/health`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        
        const responseTime = Date.now() - startTime
        
        if (response.ok) {
          const healthData = await response.json().catch(() => ({}))
          return {
            healthy: true,
            message: healthData.status || 'Supavisor is healthy',
            responseTime,
            lastChecked: new Date().toISOString()
          }
        } else {
          return {
            healthy: false,
            message: `Management port returned HTTP ${response.status}`,
            responseTime,
            lastChecked: new Date().toISOString()
          }
        }
      } catch (fetchError) {
        clearTimeout(timeoutId)
        throw fetchError
      }
    } catch (error) {
      // Fallback: check if proxy port is accessible
      try {
        const proxyPort = parseInt(process.env.POOLER_PROXY_PORT_TRANSACTION || '6543', 10)
        const isListening = await this.checkPortListening('localhost', proxyPort)
        
        return {
          healthy: isListening,
          message: isListening 
            ? 'Proxy port accessible (management port unavailable)' 
            : 'Neither management nor proxy port accessible',
          responseTime: Date.now() - startTime,
          lastChecked: new Date().toISOString()
        }
      } catch (proxyError) {
        return {
          healthy: false,
          message: `Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          responseTime: Date.now() - startTime,
          lastChecked: new Date().toISOString()
        }
      }
    }
  }

  /**
   * Check PostgreSQL health
   */
  private async checkPostgresHealth(): Promise<HealthCheckResult> {
    const startTime = Date.now()
    const port = parseInt(process.env.POSTGRES_PORT || '5432', 10)
    
    try {
      // Try to connect to PostgreSQL using a simple connection test
      const isListening = await this.checkPortListening('localhost', port)
      
      return {
        healthy: isListening,
        message: isListening ? 'PostgreSQL is accessible' : 'PostgreSQL port not accessible',
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      }
    } catch (error) {
      return {
        healthy: false,
        message: `PostgreSQL health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      }
    }
  }

  /**
   * Check Kong health
   */
  private async checkKongHealth(): Promise<HealthCheckResult> {
    const startTime = Date.now()
    const port = parseInt(process.env.KONG_HTTP_PORT || '8000', 10)
    
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      
      try {
        const response = await fetch(`http://localhost:${port}/`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        
        return {
          healthy: response.ok,
          message: response.ok ? 'Kong is healthy' : `Kong returned HTTP ${response.status}`,
          responseTime: Date.now() - startTime,
          lastChecked: new Date().toISOString()
        }
      } catch (fetchError) {
        clearTimeout(timeoutId)
        throw fetchError
      }
    } catch (error) {
      return {
        healthy: false,
        message: `Kong health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      }
    }
  }

  /**
   * Check GoTrue health
   */
  private async checkGoTrueHealth(): Promise<HealthCheckResult> {
    const startTime = Date.now()
    const port = parseInt(process.env.GOTRUE_PORT || '9999', 10)
    
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      
      try {
        const response = await fetch(`http://localhost:${port}/health`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        
        return {
          healthy: response.ok,
          message: response.ok ? 'GoTrue is healthy' : `GoTrue returned HTTP ${response.status}`,
          responseTime: Date.now() - startTime,
          lastChecked: new Date().toISOString()
        }
      } catch (fetchError) {
        clearTimeout(timeoutId)
        throw fetchError
      }
    } catch (error) {
      return {
        healthy: false,
        message: `GoTrue health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      }
    }
  }

  /**
   * Check PostgREST health
   */
  private async checkPostgRESTHealth(): Promise<HealthCheckResult> {
    const startTime = Date.now()
    const port = parseInt(process.env.POSTGREST_PORT || '3000', 10)
    
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      
      try {
        const response = await fetch(`http://localhost:${port}/`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        
        return {
          healthy: response.ok,
          message: response.ok ? 'PostgREST is healthy' : `PostgREST returned HTTP ${response.status}`,
          responseTime: Date.now() - startTime,
          lastChecked: new Date().toISOString()
        }
      } catch (fetchError) {
        clearTimeout(timeoutId)
        throw fetchError
      }
    } catch (error) {
      return {
        healthy: false,
        message: `PostgREST health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      }
    }
  }

  /**
   * Check Realtime health
   */
  private async checkRealtimeHealth(): Promise<HealthCheckResult> {
    const startTime = Date.now()
    const port = parseInt(process.env.REALTIME_PORT || '4000', 10)
    
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      
      try {
        const response = await fetch(`http://localhost:${port}/`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        
        return {
          healthy: response.ok,
          message: response.ok ? 'Realtime is healthy' : `Realtime returned HTTP ${response.status}`,
          responseTime: Date.now() - startTime,
          lastChecked: new Date().toISOString()
        }
      } catch (fetchError) {
        clearTimeout(timeoutId)
        throw fetchError
      }
    } catch (error) {
      return {
        healthy: false,
        message: `Realtime health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      }
    }
  }

  /**
   * Check Edge Functions health
   */
  private async checkEdgeFunctionsHealth(): Promise<HealthCheckResult> {
    const startTime = Date.now()
    
    // Try multiple possible ports for Edge Functions
    const possiblePorts = [
      parseInt(process.env.EDGE_FUNCTIONS_PORT || '9000', 10),
      9000, // Default Edge Functions port
      54321, // Supabase CLI default
    ]
    
    for (const port of possiblePorts) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 3000)
        
        try {
          // Try health endpoint first
          const response = await fetch(`http://localhost:${port}/health`, {
            method: 'GET',
            signal: controller.signal,
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Supabase-Studio-Docker-Health-Check',
            },
          })
          clearTimeout(timeoutId)
          
          if (response.ok) {
            const healthData = await response.json().catch(() => ({}))
            return {
              healthy: true,
              message: healthData.status || 'Edge Functions service is healthy',
              responseTime: Date.now() - startTime,
              lastChecked: new Date().toISOString()
            }
          }
        } catch (fetchError) {
          clearTimeout(timeoutId)
          
          // If health endpoint fails, try a simple connection test
          const isListening = await this.checkPortListening('localhost', port)
          if (isListening) {
            return {
              healthy: true,
              message: `Edge Functions port ${port} is accessible (health endpoint unavailable)`,
              responseTime: Date.now() - startTime,
              lastChecked: new Date().toISOString()
            }
          }
        }
      } catch (error) {
        console.debug(`Edge Functions health check failed on port ${port}:`, error)
      }
    }
    
    return {
      healthy: false,
      message: 'Edge Functions service not accessible on any known port',
      responseTime: Date.now() - startTime,
      lastChecked: new Date().toISOString()
    }
  }

  /**
   * Check Storage health
   */
  private async checkStorageHealth(): Promise<HealthCheckResult> {
    const startTime = Date.now()
    const port = parseInt(process.env.STORAGE_PORT || '5000', 10)
    
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      
      try {
        const response = await fetch(`http://localhost:${port}/status`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        
        return {
          healthy: response.ok,
          message: response.ok ? 'Storage is healthy' : `Storage returned HTTP ${response.status}`,
          responseTime: Date.now() - startTime,
          lastChecked: new Date().toISOString()
        }
      } catch (fetchError) {
        clearTimeout(timeoutId)
        throw fetchError
      }
    } catch (error) {
      return {
        healthy: false,
        message: `Storage health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        responseTime: Date.now() - startTime,
        lastChecked: new Date().toISOString()
      }
    }
  }

  /**
   * Check if a port is listening using Node.js net module
   */
  private async checkPortListening(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require('net')
      const socket = new net.Socket()
      
      const timeout = setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 2000)
      
      socket.connect(port, host, () => {
        clearTimeout(timeout)
        socket.destroy()
        resolve(true)
      })
      
      socket.on('error', () => {
        clearTimeout(timeout)
        resolve(false)
      })
    })
  }

  /**
   * Get default ports for known containers
   */
  private getDefaultPorts(containerName: string): Array<{ host: number; container: number }> {
    switch (containerName) {
      case 'supabase-edge-functions':
      case 'functions':
      case 'edge-functions':
        return [
          { 
            host: parseInt(process.env.EDGE_FUNCTIONS_PORT || '9000', 10), 
            container: 9000 
          }
        ]
      case 'supavisor':
        return [
          { 
            host: parseInt(process.env.POOLER_PROXY_PORT_TRANSACTION || '6543', 10), 
            container: 6543 
          },
          { host: 4000, container: 4000 }, // Management port
        ]
      case 'postgres':
      case 'db':
        return [
          { 
            host: parseInt(process.env.POSTGRES_PORT || '5432', 10), 
            container: 5432 
          }
        ]
      case 'kong':
        return [
          { 
            host: parseInt(process.env.KONG_HTTP_PORT || '8000', 10), 
            container: 8000 
          },
          { 
            host: parseInt(process.env.KONG_HTTPS_PORT || '8443', 10), 
            container: 8443 
          }
        ]
      default:
        return []
    }
  }

  /**
   * Restart a container using Docker CLI
   */
  async restartContainer(containerName: string): Promise<{ success: boolean; message: string }> {
    try {
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(exec)

      console.log(`Attempting to restart container: ${containerName}`)
      
      try {
        // First, check if container exists
        const { stdout: containerList } = await execAsync(
          `docker ps -a --filter "name=${containerName}" --format "{{.Names}}"`,
          { timeout: 5000 }
        )

        if (!containerList.trim()) {
          return {
            success: false,
            message: `Container '${containerName}' not found`
          }
        }

        // Restart the container
        await execAsync(`docker restart ${containerName}`, { timeout: 30000 })
        
        // Wait a moment and check if it's running
        await new Promise(resolve => setTimeout(resolve, 2000))
        
        const { stdout: runningCheck } = await execAsync(
          `docker ps --filter "name=${containerName}" --format "{{.Names}}"`,
          { timeout: 5000 }
        )

        const isRunning = runningCheck.trim().includes(containerName)
        
        return {
          success: isRunning,
          message: isRunning 
            ? `Container '${containerName}' restarted successfully`
            : `Container '${containerName}' restart initiated but not yet running`
        }
      } catch (dockerError) {
        console.error(`Docker restart failed for ${containerName}:`, dockerError)
        return {
          success: false,
          message: `Docker restart failed: ${dockerError instanceof Error ? dockerError.message : 'Unknown error'}`
        }
      }
    } catch (error) {
      console.error(`Error restarting container ${containerName}:`, error)
      return {
        success: false,
        message: `Restart failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    }
  }

  /**
   * Stop a container using Docker CLI
   */
  async stopContainer(containerName: string): Promise<{ success: boolean; message: string }> {
    try {
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(exec)

      console.log(`Attempting to stop container: ${containerName}`)
      
      try {
        await execAsync(`docker stop ${containerName}`, { timeout: 30000 })
        
        return {
          success: true,
          message: `Container '${containerName}' stopped successfully`
        }
      } catch (dockerError) {
        console.error(`Docker stop failed for ${containerName}:`, dockerError)
        return {
          success: false,
          message: `Docker stop failed: ${dockerError instanceof Error ? dockerError.message : 'Unknown error'}`
        }
      }
    } catch (error) {
      console.error(`Error stopping container ${containerName}:`, error)
      return {
        success: false,
        message: `Stop failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    }
  }

  /**
   * Start a container using Docker CLI
   */
  async startContainer(containerName: string): Promise<{ success: boolean; message: string }> {
    try {
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(exec)

      console.log(`Attempting to start container: ${containerName}`)
      
      try {
        await execAsync(`docker start ${containerName}`, { timeout: 30000 })
        
        // Wait a moment and check if it's running
        await new Promise(resolve => setTimeout(resolve, 2000))
        
        const { stdout: runningCheck } = await execAsync(
          `docker ps --filter "name=${containerName}" --format "{{.Names}}"`,
          { timeout: 5000 }
        )

        const isRunning = runningCheck.trim().includes(containerName)
        
        return {
          success: isRunning,
          message: isRunning 
            ? `Container '${containerName}' started successfully`
            : `Container '${containerName}' start initiated but not yet running`
        }
      } catch (dockerError) {
        console.error(`Docker start failed for ${containerName}:`, dockerError)
        return {
          success: false,
          message: `Docker start failed: ${dockerError instanceof Error ? dockerError.message : 'Unknown error'}`
        }
      }
    } catch (error) {
      console.error(`Error starting container ${containerName}:`, error)
      return {
        success: false,
        message: `Start failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    }
  }

  /**
   * Get container logs using Docker CLI
   */
  async getContainerLogs(containerName: string, lines: number = 100): Promise<string[]> {
    try {
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(exec)

      console.log(`Fetching logs for container: ${containerName}, lines: ${lines}`)
      
      try {
        const { stdout } = await execAsync(
          `docker logs --tail ${lines} ${containerName}`,
          { timeout: 10000 }
        )
        
        if (!stdout.trim()) {
          return [`No logs available for container '${containerName}'`]
        }
        
        return stdout.trim().split('\n').filter(line => line.trim())
      } catch (dockerError) {
        console.error(`Docker logs failed for ${containerName}:`, dockerError)
        return [
          `Error retrieving logs: ${dockerError instanceof Error ? dockerError.message : 'Unknown error'}`,
          `Container '${containerName}' may not exist or Docker is not accessible`
        ]
      }
    } catch (error) {
      console.error(`Error getting logs for container ${containerName}:`, error)
      return [`Error retrieving logs: ${error instanceof Error ? error.message : 'Unknown error'}`]
    }
  }

  /**
   * Get all containers status
   */
  async getAllContainersStatus(): Promise<ContainerStatus[]> {
    try {
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(exec)

      try {
        const { stdout } = await execAsync(
          'docker ps -a --format "{{json .}}"',
          { timeout: 10000 }
        )
        
        if (!stdout.trim()) {
          return []
        }
        
        const containers: ContainerStatus[] = []
        const lines = stdout.trim().split('\n')
        
        for (const line of lines) {
          try {
            const containerInfo = JSON.parse(line)
            const isRunning = containerInfo.State === 'running'
            const containerName = containerInfo.Names.replace(/^\//, '') // Remove leading slash
            
            const status = this.parseDockerContainerInfo(containerInfo, containerName, isRunning)
            
            // Get health status for running containers
            if (isRunning) {
              const health = await this.getContainerHealth(containerName)
              status.health = health.healthy ? 'healthy' : 'unhealthy'
            }
            
            containers.push(status)
          } catch (parseError) {
            console.warn('Failed to parse container info:', parseError)
          }
        }
        
        return containers
      } catch (dockerError) {
        console.error('Failed to get all containers status:', dockerError)
        return []
      }
    } catch (error) {
      console.error('Error getting all containers status:', error)
      return []
    }
  }

  /**
   * Get Supabase-specific containers status
   */
  async getSupabaseContainersStatus(): Promise<ContainerStatus[]> {
    const supabaseContainers = [
      'supavisor', 'postgres', 'db', 'kong', 'gotrue', 
      'postgrest', 'realtime', 'storage', 'imgproxy', 
      'meta', 'studio', 'edge-runtime', 'functions', 
      'supabase-edge-functions', 'edge-functions'
    ]
    
    const allContainers = await this.getAllContainersStatus()
    
    return allContainers.filter(container => 
      supabaseContainers.some(name => 
        container.name.includes(name) || container.name.includes(`supabase-${name}`)
      )
    )
  }
}