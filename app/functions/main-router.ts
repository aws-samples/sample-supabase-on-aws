import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { scryptSync, createDecipheriv } from "node:crypto"

// 支持通过环境变量动态配置
const WORKER_MEMORY_MB = parseInt(Deno.env.get("WORKER_MEMORY_MB") || "128")
const WORKER_TIMEOUT_MS = parseInt(Deno.env.get("WORKER_TIMEOUT_MS") || "60000")
const PORT = parseInt(Deno.env.get("PORT") || "8080")

// Secrets 存储配置
const SECRETS_PATH = Deno.env.get("SUPABASE_SECRETS_PATH") || "/home/deno/functions/.supabase/secrets"
// fail-fast: the encryption key MUST be provided. A hard-coded fallback meant
// that a misconfigured deploy would silently derive a publicly-known key and
// decrypt every tenant's secrets with it. CDK injects this from Secrets Manager
// (ecs.Secret.fromSecretsManager), so a correctly-deployed container always has it.
const ENCRYPTION_KEY_RAW = Deno.env.get("SUPABASE_ENCRYPTION_KEY")
if (!ENCRYPTION_KEY_RAW) {
  console.error("FATAL: SUPABASE_ENCRYPTION_KEY is not set. Refusing to start with an insecure default.")
  Deno.exit(1)
}
// Narrowed to string: execution only reaches here when the key is present
// (Deno.exit above terminates the process otherwise).
const ENCRYPTION_KEY: string = ENCRYPTION_KEY_RAW

// SECURITY (tenant isolation): the worker runs UNTRUSTED tenant-supplied code,
// so the host process env is an allowlist, NOT a denylist. A denylist would
// have to enumerate every present and future sensitive var — and it already
// misses things like ECS_CONTAINER_METADATA_URI(_V4) and
// AWS_CONTAINER_CREDENTIALS_RELATIVE_URI (task IAM-role credential entrypoints),
// which would let tenant code assume the task role or read platform metadata.
// We forward ONLY the host vars explicitly named in WORKER_ENV_ALLOWLIST
// (comma-separated), and never anything else. The platform master key
// SUPABASE_ENCRYPTION_KEY and the secrets path stay on the host only. A tenant
// function's own config arrives via projectSecrets, which is merged separately.
const WORKER_ENV_ALLOWLIST = new Set(
  (Deno.env.get("WORKER_ENV_ALLOWLIST") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
)

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

/**
 * Classify a worker error into a precise HTTP status + structured body.
 *
 * Background (二期 PDF §6): the old handler collapsed three distinct failures
 * into a single 404 {"msg":"Function not found"}:
 *   - the function directory / entrypoint genuinely does not exist
 *   - the user's code has a SYNTAX error (Edge Runtime cannot parse it)
 *   - the worker fails to boot for another reason
 * Users hit a syntax error in their own code, saw "Function not found", and
 * filed it as a platform bug. We now split these so the response itself tells
 * the user whether the file is missing (404) or their code is broken (422),
 * and always surface the raw runtime error in `detail`.
 *
 * IMPORTANT ordering: boot/parse errors are checked FIRST, because their
 * messages frequently also contain the substring "not found" (e.g. a module
 * import that fails to resolve), which would otherwise be misclassified as 404.
 */
function classifyWorkerError(
  errMsg: string,
  functionPath: string,
): { status: number; code: string; body: Record<string, unknown> } {
  const lower = errMsg.toLowerCase()

  // 1) Missing function / entrypoint → 404. This MUST come before the boot
  //    error check, because edge-runtime reports a missing entrypoint *inside*
  //    a "worker boot error" envelope, e.g.:
  //      "worker boot error: failed to bootstrap runtime: could not find an
  //       appropriate entrypoint"
  //    That is a genuinely-missing function, not a user code error — so we
  //    detect the entrypoint/not-found signal first and return 404.
  const notFoundSignals = [
    "could not find an appropriate entrypoint",
    "entrypoint",
    "no such file",
    "not found",
    "notfound",
  ]
  if (notFoundSignals.some((s) => lower.includes(s))) {
    return {
      status: 404,
      code: "FUNCTION_NOT_FOUND",
      body: {
        code: "FUNCTION_NOT_FOUND",
        msg: "Function not found",
        function: functionPath,
      },
    }
  }

  // 2) Code-level boot / parse / graph errors → 422 (user's code is broken).
  //    Samples from production logs (PDF §6):
  //      "failed to create the graph: ... source code could not be parsed: Expected ',', got '...'"
  //      "Parenthesized expression cannot be empty"
  const bootSignals = [
    "boot error",
    "failed to create the graph",
    "source code could not be parsed",
    "failed to bootstrap runtime",
    "expected ",          // "Expected ',', got ..."
    "parenthesized expression",
    "syntaxerror",
    "unexpected token",
    "unexpected eof",
  ]
  if (bootSignals.some((s) => lower.includes(s))) {
    return {
      status: 422,
      code: "FUNCTION_BOOT_ERROR",
      body: {
        code: "FUNCTION_BOOT_ERROR",
        msg: "Function failed to start due to an error in the function code",
        function: functionPath,
        detail: errMsg,
      },
    }
  }

  // 3) Worker timeout → 504.
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      status: 504,
      code: "FUNCTION_TIMEOUT",
      body: {
        code: "FUNCTION_TIMEOUT",
        msg: "Function execution timed out",
        function: functionPath,
        detail: errMsg,
      },
    }
  }

  // 4) Anything else → 500, still surfacing the raw message for diagnosis.
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    body: {
      code: "INTERNAL_ERROR",
      msg: "Internal server error",
      function: functionPath,
      detail: errMsg,
    },
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
    
    // Build the worker env from an ALLOWLIST of host vars (default: none), then
    // merge the tenant's own secrets on top (projectSecrets wins on conflict).
    // Previously the ENTIRE host env (incl. SUPABASE_ENCRYPTION_KEY, the master
    // key that decrypts all tenants' secrets) was forwarded verbatim, so any
    // tenant function could read Deno.env and exfiltrate it. Now only explicitly
    // allowlisted host vars cross the boundary.
    const hostEnv = Deno.env.toObject()
    const baseEnvVars: Record<string, string> = {}
    for (const name of WORKER_ENV_ALLOWLIST) {
      const v = hostEnv[name]
      if (v !== undefined) baseEnvVars[name] = v
    }
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
    const classified = classifyWorkerError(errMsg, functionPath)
    // boot/语法错误用 warn 级别记录原始信息，便于用户与运维排查
    console.error(`Worker error for ${servicePath} [${classified.code}]:`, errMsg)
    return new Response(
      JSON.stringify(classified.body),
      {status: classified.status, headers: {"Content-Type": "application/json"}}
    )
  }
}, { port: PORT })

console.log(`Functions service listening on port ${PORT}`)
