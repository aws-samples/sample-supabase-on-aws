import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { scryptSync, createDecipheriv } from "node:crypto"

// 支持通过环境变量动态配置
const WORKER_MEMORY_MB = parseInt(Deno.env.get("WORKER_MEMORY_MB") || "128")
const WORKER_TIMEOUT_MS = parseInt(Deno.env.get("WORKER_TIMEOUT_MS") || "60000")
const PORT = parseInt(Deno.env.get("PORT") || "8080")

// Secrets 存储配置
const SECRETS_PATH = Deno.env.get("SUPABASE_SECRETS_PATH") || "/home/deno/functions/.supabase/secrets"
const ENCRYPTION_KEY = Deno.env.get("SUPABASE_ENCRYPTION_KEY") || "default-key-change-in-production"

// Secrets 缓存（每个项目缓存 60 秒）
const secretsCache = new Map<string, { secrets: Record<string, string>, expiry: number }>()
const SECRETS_CACHE_TTL_MS = 60000

/**
 * 使用 AES-256-GCM 解密数据（与 Studio 的加密实现兼容）
 */
function decrypt(encryptedData: string, key: string): string {
  const algorithm = 'aes-256-gcm'
  const keyBuffer = scryptSync(key, 'salt', 32)
  const parts = encryptedData.split(':')
  
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format')
  }
  
  // 使用 Uint8Array 代替 Buffer
  const iv = new Uint8Array(parts[0].match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)))
  const authTag = new Uint8Array(parts[1].match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)))
  const encrypted = parts[2]
  
  const decipher = createDecipheriv(algorithm, keyBuffer, iv)
  decipher.setAuthTag(authTag)
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  
  return decrypted
}

/**
 * 从文件系统加载项目的 secrets
 */
async function getProjectSecrets(projectRef: string): Promise<Record<string, string>> {
  const cached = secretsCache.get(projectRef)
  if (cached && cached.expiry > Date.now()) {
    return cached.secrets
  }

  const secrets: Record<string, string> = {}
  const secretsFilePath = `${SECRETS_PATH}/${projectRef}.json`

  try {
    const data = await Deno.readTextFile(secretsFilePath)
    const encryptedSecrets = JSON.parse(data)
    
    if (Array.isArray(encryptedSecrets)) {
      for (const encrypted of encryptedSecrets) {
        try {
          const decrypted = decrypt(encrypted, ENCRYPTION_KEY)
          const secret = JSON.parse(decrypted)
          if (secret.name && secret.value) {
            secrets[secret.name] = secret.value
          }
        } catch (e) {
          console.error(`Failed to decrypt secret:`, e)
        }
      }
    }

    secretsCache.set(projectRef, {
      secrets,
      expiry: Date.now() + SECRETS_CACHE_TTL_MS
    })

    return secrets
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(`Error loading secrets for project ${projectRef}:`, e)
    }
    return {}
  }
}

console.log(`Functions service: WORKER_CACHE=disabled, MEMORY=${WORKER_MEMORY_MB}MB, TIMEOUT=${WORKER_TIMEOUT_MS}ms`)

serve(async (req) => {
  let path = new URL(req.url).pathname
  
  // Remove leading slash
  if (path.startsWith('/')) path = path.substring(1)
  
  // Remove v1/ prefix if present (from non-stripped Kong routes)
  if (path.startsWith('v1/')) path = path.substring(3)
  
  // Clean up path
  path = path.split("/").filter(x => x).join("/")
  
  // Health endpoint
  if (path === "health" || path === "healthcheck") {
    return new Response(
      JSON.stringify({
        status: "healthy", 
        timestamp: new Date().toISOString(),
        cache: "disabled"
      }),
      {headers: {"Content-Type": "application/json"}}
    )
  }
  
  // Missing function name
  if (!path) {
    return new Response(
      JSON.stringify({msg: "missing function"}),
      {status: 400, headers: {"Content-Type": "application/json"}}
    )
  }

  // Get project ref from header (multi-tenant support)
  const projectRef = req.headers.get("X-Project-ID") || req.headers.get("x-project-id")
  
  // Check if path already starts with projectRef (e.g., /1lcx7w4ugv8t0ndq6lbr/hello)
  let functionPath = path
  if (projectRef && path.startsWith(`${projectRef}/`)) {
    // Path already includes projectRef, remove it
    functionPath = path.substring(projectRef.length + 1)
  }
  
  const basePath = projectRef ? `/home/deno/functions/${projectRef}` : `/home/deno/functions`
  
  // servicePath should point to the function directory (not the file)
  // edge-runtime will automatically look for index.ts, index.js, main.ts, or main.js
  const servicePath = `${basePath}/${functionPath}`
  
  try {
    // 获取项目的 secrets（如果有 projectRef）
    let projectSecrets: Record<string, string> = {}
    if (projectRef) {
      projectSecrets = await getProjectSecrets(projectRef)
    }
    
    // 合并容器环境变量和项目 secrets
    // 项目 secrets 优先级更高，会覆盖同名的容器环境变量
    const baseEnvVars = Deno.env.toObject()
    const mergedEnvVars = { ...baseEnvVars, ...projectSecrets }
    
    // 每次创建新 worker（无缓存）
    console.debug(`Creating ephemeral worker for: ${servicePath} (with ${Object.keys(projectSecrets).length} project secrets)`)
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: WORKER_MEMORY_MB,
      workerTimeoutMs: WORKER_TIMEOUT_MS,
      importMapPath: null,
      envVars: Object.entries(mergedEnvVars)
    })
    
    try {
      return await worker.fetch(req)
    } finally {
      // 执行完成后立即终止 worker
      try {
        await worker.terminate?.()
      } catch (e) {
        console.error(`Failed to terminate worker:`, e)
      }
    }
  } catch (e) {
    const errMsg = e.toString()
    // 函数不存在或入口文件找不到 → 404
    if (errMsg.includes("entrypoint") || errMsg.includes("not found") || errMsg.includes("NotFound") || errMsg.includes("boot error")) {
      return new Response(
        JSON.stringify({msg: "Function not found", function: functionPath}),
        {status: 404, headers: {"Content-Type": "application/json"}}
      )
    }
    console.error(`Worker error for ${servicePath}:`, errMsg)
    return new Response(
      JSON.stringify({msg: "Internal server error"}),
      {status: 500, headers: {"Content-Type": "application/json"}}
    )
  }
}, { port: PORT })

console.log(`Functions service listening on port ${PORT}`)
