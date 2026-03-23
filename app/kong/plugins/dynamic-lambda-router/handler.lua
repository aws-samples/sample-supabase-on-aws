local http = require "resty.http"
local cjson = require "cjson"
local redis = require "resty.redis"
local aws = require "resty.aws"
local resty_sha256 = require "resty.sha256"
local str = require "resty.string"
local openssl_hmac = require "resty.openssl.hmac"
local bit = bit    -- LuaJIT built-in bitwise operations

local ngx = ngx
local kong = kong
local fmt = string.format
local concat = table.concat
local sort = table.sort

local DynamicLambdaRouterHandler = {
  PRIORITY = 1001,
  VERSION = "2.0.0",
}

-- Redis 连接配置（从环境变量读取）
local REDIS_HOST = os.getenv("KONG_REDIS_HOST")
local REDIS_PORT = tonumber(os.getenv("KONG_REDIS_PORT")) or 6379
local REDIS_PASSWORD = os.getenv("KONG_REDIS_PASSWORD")
local REDIS_SSL = os.getenv("KONG_REDIS_SSL") == "true"
local REDIS_TIMEOUT = 100  -- 100ms (VPC-internal should be <5ms)
local REDIS_POOL_SIZE = 100
local REDIS_KEEPALIVE = 60000  -- 60 seconds

-- L1: per-worker in-process cache (eliminates Redis dependency on hot path)
local _l1_cache = {}
local _l1_expiry = {}
local L1_TTL = 300  -- 5 minutes, same as Redis TTL

local function l1_get(key)
  local exp = _l1_expiry[key]
  if exp and exp > ngx.now() then
    return _l1_cache[key]
  end
  -- Expired or missing: clean up
  _l1_cache[key] = nil
  _l1_expiry[key] = nil
  return nil
end

local function l1_set(key, value, ttl)
  _l1_cache[key] = value
  _l1_expiry[key] = ngx.now() + (ttl or L1_TTL)
end

-- Circuit breaker: skip Redis after consecutive failures
local _redis_fail_count = 0
local _redis_circuit_open_until = 0
local REDIS_CIRCUIT_THRESHOLD = 3    -- open circuit after 3 failures
local REDIS_CIRCUIT_COOLDOWN = 30    -- retry Redis after 30 seconds

-- AWS SDK singleton
local AWS_INSTANCE
local function initialize_aws()
  if not AWS_INSTANCE then
    AWS_INSTANCE = aws()
    kong.log.debug("AWS SDK initialized - using ECS Task Role")
  end
  return AWS_INSTANCE
end

-- SigV4 Signing Helper Functions
local function get_iso_timestamp()
  return os.date("!%Y%m%dT%H%M%SZ")
end

local function get_date_stamp()
  return os.date("!%Y%m%d")
end

local function sha256_hex(data)
  local sha256 = resty_sha256:new()
  sha256:update(data)
  local digest = sha256:final()
  return str.to_hex(digest)
end

local function hmac_sha256(key, data)
  local hmac = openssl_hmac.new(key, "sha256")
  return hmac:final(data)
end

local function get_signature_key(key, date_stamp, region, service)
  local k_date = hmac_sha256("AWS4" .. key, date_stamp)
  local k_region = hmac_sha256(k_date, region)
  local k_service = hmac_sha256(k_region, service)
  local k_signing = hmac_sha256(k_service, "aws4_request")
  return k_signing
end

-- SigV4 URI encode: encode all characters except unreserved (A-Za-z0-9-_.~)
local function sigv4_uri_encode(str_val, encode_slash)
  if not str_val then return "" end
  local encoded = {}
  for i = 1, #str_val do
    local c = str_val:sub(i, i)
    local b = string.byte(c)
    if (b >= 65 and b <= 90)   -- A-Z
      or (b >= 97 and b <= 122) -- a-z
      or (b >= 48 and b <= 57)  -- 0-9
      or c == '-' or c == '_' or c == '.' or c == '~' then
      table.insert(encoded, c)
    elseif c == '/' and not encode_slash then
      table.insert(encoded, c)
    else
      table.insert(encoded, fmt("%%%02X", b))
    end
  end
  return concat(encoded, "")
end

-- URL decode: reverse percent-encoding so SigV4 can re-encode consistently
local function url_decode(str_val)
  if not str_val then return "" end
  return str_val:gsub("%%(%x%x)", function(h)
    return string.char(tonumber(h, 16))
  end)
end

-- Normalize query string for SigV4 canonical request
-- Must decode first then re-encode, because Kong may pass pre-encoded values
-- (e.g., select=%2A instead of select=*), which would otherwise get double-encoded
local function normalize_query_string(raw_query)
  if not raw_query or raw_query == "" then return "" end
  local params = {}
  for param in raw_query:gmatch("[^&]+") do
    local eq_pos = param:find("=")
    if eq_pos then
      local key = url_decode(param:sub(1, eq_pos - 1))
      local val = url_decode(param:sub(eq_pos + 1))
      table.insert(params, { sigv4_uri_encode(key, true), sigv4_uri_encode(val, true) })
    else
      table.insert(params, { sigv4_uri_encode(url_decode(param), true), "" })
    end
  end
  sort(params, function(a, b)
    if a[1] == b[1] then
      return a[2] < b[2]
    end
    return a[1] < b[1]
  end)
  local parts = {}
  for _, p in ipairs(params) do
    table.insert(parts, p[1] .. "=" .. p[2])
  end
  return concat(parts, "&")
end

local function create_canonical_request(method, uri, query_string, headers, payload_hash)
  -- Decode first to avoid double-encoding pre-encoded paths
  local canonical_uri = sigv4_uri_encode(url_decode(uri or "/"), false)
  local canonical_querystring = normalize_query_string(query_string)

  local canonical_headers_list = {}
  local signed_headers_list = {}

  for k, v in pairs(headers) do
    local lower_key = k:lower()
    table.insert(canonical_headers_list, lower_key .. ":" .. v:gsub("%s+", " "))
    table.insert(signed_headers_list, lower_key)
  end

  sort(canonical_headers_list)
  sort(signed_headers_list)

  local canonical_headers = concat(canonical_headers_list, "\n") .. "\n"
  local signed_headers = concat(signed_headers_list, ";")

  local canonical_request = concat({
    method,
    canonical_uri,
    canonical_querystring,
    canonical_headers,
    signed_headers,
    payload_hash
  }, "\n")

  return canonical_request, signed_headers
end

-- Redis connection options (TLS handled inside connect, same pattern as Kong's rate-limiting plugin)
local _redis_sock_opts = {}
if REDIS_SSL then
  _redis_sock_opts.ssl = true
  _redis_sock_opts.ssl_verify = true
  _redis_sock_opts.server_name = REDIS_HOST
end

-- Redis 连接管理
local function get_redis_connection()
  if not REDIS_HOST then
    return nil, "KONG_REDIS_HOST not configured"
  end

  -- Circuit breaker: skip Redis if circuit is open
  if _redis_circuit_open_until > ngx.now() then
    return nil, "Redis circuit breaker open"
  end

  local red = redis:new()
  red:set_timeout(REDIS_TIMEOUT)

  -- connect() with ssl opts: fresh connections do TCP+TLS in one step;
  -- pooled connections return the existing TLS connection without re-handshake
  local ok, err = red:connect(REDIS_HOST, REDIS_PORT, _redis_sock_opts)
  if not ok then
    _redis_fail_count = _redis_fail_count + 1
    if _redis_fail_count >= REDIS_CIRCUIT_THRESHOLD then
      _redis_circuit_open_until = ngx.now() + REDIS_CIRCUIT_COOLDOWN
      kong.log.warn("Redis circuit breaker OPEN for ", REDIS_CIRCUIT_COOLDOWN, "s after ", _redis_fail_count, " connect failures")
    end
    return nil, "Failed to connect to Redis: " .. (err or "unknown error")
  end

  -- AUTH only on fresh connections (pooled connections are already authenticated)
  local times, times_err = red:get_reused_times()
  if times_err then
    red:close()
    return nil, "Failed to get reused times: " .. times_err
  end

  if times == 0 then
    -- Fresh connection: authenticate
    if REDIS_PASSWORD then
      local auth_ok, auth_err = red:auth(REDIS_PASSWORD)
      if not auth_ok then
        red:close()
        return nil, "Redis AUTH failed: " .. (auth_err or "unknown error")
      end
    end
    kong.log.debug("Redis fresh connection established (TLS=", REDIS_SSL, ")")
  end

  -- Connection succeeded: reset circuit breaker
  _redis_fail_count = 0
  _redis_circuit_open_until = 0

  return red, nil
end

local function close_redis_connection(red)
  if not red then
    return
  end

  local ok, err = red:set_keepalive(REDIS_KEEPALIVE, REDIS_POOL_SIZE)
  if not ok then
    kong.log.warn("Failed to set Redis keepalive: ", err)
  end
end

-- Batch Redis MGET for two keys in a single connection
local function mget_from_redis(key1, key2)
  local red, err = get_redis_connection()
  if not red then
    return nil, nil, false
  end

  local results, redis_err = red:mget(key1, key2)

  close_redis_connection(red)

  if redis_err or not results then
    kong.log.warn("Redis MGET failed: ", redis_err or "nil result")
    return nil, nil, false
  end

  local val1 = results[1]
  local val2 = results[2]
  if val1 == ngx.null then val1 = nil end
  if val2 == ngx.null then val2 = nil end

  return val1, val2, true
end

-- Batch Redis write: pipeline SETEX for two keys
local function mset_to_redis(key1, val1, key2, val2, ttl)
  local red, err = get_redis_connection()
  if not red then
    return false
  end

  red:init_pipeline(2)
  red:setex(key1, ttl, val1)
  red:setex(key2, ttl, val2)

  local results, pipeline_err = red:commit_pipeline()

  close_redis_connection(red)

  if pipeline_err then
    kong.log.warn("Redis pipeline SETEX failed: ", pipeline_err)
    return false
  end

  return true
end

-- JWT minting helpers
local function base64url_encode(input)
  local b64 = ngx.encode_base64(input)
  return b64:gsub("+", "-"):gsub("/", "_"):gsub("=", "")
end

local function base64url_decode(input)
  if not input then return nil end
  local padded = input:gsub("-", "+"):gsub("_", "/")
  local remainder = #padded % 4
  if remainder > 0 then
    padded = padded .. string.rep("=", 4 - remainder)
  end
  return ngx.decode_base64(padded)
end

local function decode_jwt_payload(token)
  if not token then return nil, "no token" end
  local parts = {}
  for part in token:gmatch("[^%.]+") do
    table.insert(parts, part)
  end
  if #parts ~= 3 then return nil, "invalid JWT structure" end
  local payload_json = base64url_decode(parts[2])
  if not payload_json then return nil, "failed to decode payload" end
  local ok, claims = pcall(cjson.decode, payload_json)
  if not ok then return nil, "failed to parse payload JSON" end
  return claims, nil
end

local function verify_jwt(token, secret)
  if not token or not secret then return nil, "missing token or secret" end

  local parts = {}
  for part in token:gmatch("[^%.]+") do
    table.insert(parts, part)
  end
  if #parts ~= 3 then return nil, "invalid JWT structure" end

  -- Decode and verify header: only HS256 accepted
  local header_json = base64url_decode(parts[1])
  if not header_json then return nil, "failed to decode header" end
  local ok_h, header = pcall(cjson.decode, header_json)
  if not ok_h then return nil, "failed to parse header" end
  if header.alg ~= "HS256" then return nil, "unsupported algorithm: " .. tostring(header.alg) end

  -- Compute expected signature
  local signing_input = parts[1] .. "." .. parts[2]
  local hmac = openssl_hmac.new(secret, "SHA256")
  local expected_sig = hmac:final(signing_input)
  local actual_sig = base64url_decode(parts[3])
  if not actual_sig then return nil, "failed to decode signature" end

  -- Constant-time comparison using bitwise OR of XOR differences
  if #expected_sig ~= #actual_sig then return nil, "signature length mismatch" end
  local diff = 0
  for i = 1, #expected_sig do
    diff = bit.bor(diff, bit.bxor(string.byte(expected_sig, i), string.byte(actual_sig, i)))
  end
  if diff ~= 0 then return nil, "signature verification failed" end

  -- Decode payload
  local payload_json = base64url_decode(parts[2])
  if not payload_json then return nil, "failed to decode payload" end
  local ok_p, claims = pcall(cjson.decode, payload_json)
  if not ok_p then return nil, "failed to parse payload" end

  -- Check expiry with 5s clock skew tolerance
  local now = ngx.time()
  if claims.exp and claims.exp + 5 < now then
    return nil, "token expired"
  end

  return claims, nil
end

local function mint_jwt(project_id, role, jwt_secret, extra_claims)
  local header = base64url_encode('{"alg":"HS256","typ":"JWT"}')
  local now = ngx.time()
  local payload_table = {
    iss = "supabase",
    ref = project_id,
    role = role,
    iat = now,
    exp = now + 300,
  }
  -- Merge extra claims (GoTrue claims passthrough), but protect reserved keys
  if extra_claims then
    local protected = { iss = true, ref = true, role = true, iat = true, exp = true }
    for k, v in pairs(extra_claims) do
      if not protected[k] then
        payload_table[k] = v
      end
    end
  end
  local payload = base64url_encode(cjson.encode(payload_table))
  local signing_input = header .. "." .. payload
  local hmac = openssl_hmac.new(jwt_secret, "SHA256")
  local signature = hmac:final(signing_input)
  return signing_input .. "." .. base64url_encode(signature)
end

-- Get project config with 3-tier cache: L1 (worker memory) → L2 (Redis MGET) → L3 (tenant-manager API)
local function get_project_config(conf, project_id)
  local fn_cache_key = "lambda:fn:" .. project_id
  local jwt_cache_key = "jwt:secret:" .. project_id

  -- L1: per-worker memory cache (~0ms)
  local fn_url = l1_get(fn_cache_key)
  local jwt_secret = l1_get(jwt_cache_key)
  if fn_url and jwt_secret then
    return fn_url, jwt_secret, nil
  end

  -- L2: Redis MGET (single connection for both keys)
  local redis_fn, redis_jwt, redis_ok = mget_from_redis(fn_cache_key, jwt_cache_key)
  if redis_fn and redis_jwt then
    -- Populate L1 from Redis hit
    l1_set(fn_cache_key, redis_fn, conf.cache_ttl)
    l1_set(jwt_cache_key, redis_jwt, conf.cache_ttl)
    kong.log.debug("L2 Redis cache hit for project ", project_id)
    return redis_fn, redis_jwt, nil
  end

  -- L3: tenant-manager API fallback
  kong.log.info("L3 cache miss for project ", project_id, ", calling tenant-manager")

  local httpc = http.new()
  httpc:set_timeout(5000)

  local url = conf.project_service_url .. "/project/" .. project_id .. "/config"
  kong.log.debug("Fetching project config from: ", url)

  local res, err = httpc:request_uri(url, {
    method = "GET",
    headers = {
      ["Accept"] = "application/json",
    }
  })

  if not res then
    kong.log.err("Failed to call tenant-manager: ", err)
    return nil, nil, "Failed to get project config: " .. (err or "unknown error")
  end

  if res.status ~= 200 then
    kong.log.err("tenant-manager returned status: ", res.status, " body: ", res.body)
    return nil, nil, "tenant-manager returned status: " .. res.status
  end

  local ok, data = pcall(cjson.decode, res.body)
  if not ok then
    kong.log.err("Failed to parse JSON response: ", res.body)
    return nil, nil, "Invalid JSON response from tenant-manager"
  end

  if not data.function_url then
    kong.log.err("No function_url in response: ", res.body)
    return nil, nil, "No function_url in project config"
  end

  if not data.jwt_secret then
    kong.log.err("No jwt_secret in response: ", res.body)
    return nil, nil, "No jwt_secret in project config"
  end

  -- Write-back to L1 (always)
  l1_set(fn_cache_key, data.function_url, conf.cache_ttl)
  l1_set(jwt_cache_key, data.jwt_secret, conf.cache_ttl)

  -- Write-back to L2 Redis (best-effort, non-blocking for the response)
  if redis_ok then
    mset_to_redis(fn_cache_key, data.function_url, jwt_cache_key, data.jwt_secret, conf.cache_ttl)
  end

  kong.log.debug("Got project config for ", project_id, ": function_url=", data.function_url)
  return data.function_url, data.jwt_secret, nil
end

function DynamicLambdaRouterHandler:access(conf)
  -- 获取 Project ID from header
  local project_id = kong.request.get_header(conf.project_header)

  -- 如果没有 Project ID，跳过此插件
  if not project_id then
    kong.log.debug("No ", conf.project_header, " header found, skipping dynamic routing")
    return
  end

  kong.log.debug("Processing request for project: ", project_id)

  -- Validate API key belongs to the requested project
  local consumer = kong.client.get_consumer()
  if consumer and consumer.username then
    local consumer_project = consumer.username:match("^(.+)%-%-")
    if not consumer_project or consumer_project ~= project_id then
      kong.log.err("API key project mismatch: consumer=", consumer.username, " requested_project=", project_id)
      return kong.response.exit(403, {
        error = "Forbidden",
        message = "API key does not belong to this project"
      })
    end
    kong.log.debug("API key validated for project: ", project_id)
  end

  -- Get project config (function_url + jwt_secret)
  local function_url, jwt_secret, err = get_project_config(conf, project_id)
  if err then
    kong.log.err("Error getting project config: ", err)
    return kong.response.exit(500, {
      error = "Failed to route request",
      message = err,
      project_id = project_id
    })
  end

  -- 获取请求信息
  local request_path = kong.request.get_path()
  local request_query = kong.request.get_raw_query()
  local request_method = kong.request.get_method()
  local request_headers = kong.request.get_headers()
  local request_body = kong.request.get_raw_body()

  kong.log.debug("[route] Original request_path: '", request_path, "'")
  kong.log.debug("[route] Request query: '", request_query or "none", "'")
  kong.log.debug("[route] Request method: ", request_method)

  -- Kong的strip_path在access阶段可能还没生效，手动去除 /rest/v1/ 前缀
  local target_path = request_path

  if string.sub(target_path, 1, 9) == "/rest/v1/" then
    target_path = string.sub(target_path, 9)
    kong.log.debug("[route] Stripped /rest/v1 prefix, new path: '", target_path, "'")
  elseif target_path == "/rest/v1" then
    target_path = "/"
    kong.log.debug("[route] Stripped /rest/v1 to root: '", target_path, "'")
  end

  -- 确保路径以/开头
  if target_path == "" or target_path == nil then
    target_path = "/"
  elseif string.sub(target_path, 1, 1) ~= "/" then
    target_path = "/" .. target_path
  end

  kong.log.debug("[route] Final target path for Lambda: '", target_path, "'")

  -- 移除 function_url 尾部斜杠避免双斜杠
  local base_url = function_url
  if string.sub(base_url, -1) == "/" then
    base_url = string.sub(base_url, 1, -2)
  end

  -- 构建完整 URL
  local target_url = base_url .. target_path
  if request_query and request_query ~= "" then
    target_url = target_url .. "?" .. request_query
  end

  kong.log.debug("Calling Lambda Function URL: ", function_url, " with path: ", target_path)

  -- 获取 AWS 凭证
  local aws_instance = initialize_aws()
  local credentials = aws_instance.config.credentials

  if not credentials then
    kong.log.err("Failed to get credentials provider")
    return kong.response.exit(500, { message = "Failed to get AWS credentials provider" })
  end

  local ok, cred_err = credentials:get()
  if not ok then
    kong.log.err("Failed to fetch credentials: ", tostring(cred_err))
    return kong.response.exit(500, { message = "Failed to fetch AWS credentials from Task Role" })
  end

  -- 读取凭证（驼峰命名）
  local access_key = credentials.accessKeyId
  local secret_key = credentials.secretAccessKey
  local session_token = credentials.sessionToken

  if not access_key or not secret_key then
    kong.log.err("AWS credentials incomplete")
    return kong.response.exit(500, { message = "AWS credentials incomplete" })
  end

  -- 准备 SigV4 签名参数
  local region = conf.aws_region or "us-east-1"
  local service = "lambda"
  local algorithm = "AWS4-HMAC-SHA256"
  local timestamp = get_iso_timestamp()
  local date_stamp = get_date_stamp()
  local credential_scope = date_stamp .. "/" .. region .. "/" .. service .. "/aws4_request"

  -- 解析 Function URL 的 host
  local function_url_host = function_url:match("https?://([^/]+)")
  if not function_url_host then
    kong.log.err("Failed to parse Function URL host from: ", function_url)
    return kong.response.exit(500, { message = "Invalid Function URL format" })
  end

  -- Hash payload
  local payload_hash = sha256_hex(request_body or "")

  -- 准备签名的 headers
  local headers_to_sign = {
    host = function_url_host,
    ["x-amz-date"] = timestamp,
    ["content-type"] = request_headers["content-type"] or "application/json",
  }

  if session_token then
    headers_to_sign["x-amz-security-token"] = session_token
  end

  -- 创建 canonical request
  local canonical_request, signed_headers = create_canonical_request(
    request_method,
    target_path,
    request_query or "",
    headers_to_sign,
    payload_hash
  )

  -- 创建 string to sign
  local canonical_request_hash = sha256_hex(canonical_request)
  local string_to_sign = concat({
    algorithm,
    timestamp,
    credential_scope,
    canonical_request_hash
  }, "\n")

  -- 计算签名
  local signing_key = get_signature_key(secret_key, date_stamp, region, service)
  local signature = str.to_hex(hmac_sha256(signing_key, string_to_sign))

  -- 创建 Authorization header
  local authorization_header = fmt(
    "%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
    algorithm,
    access_key,
    credential_scope,
    signed_headers,
    signature
  )

  -- 转发客户端所有 headers，然后覆盖 SigV4 相关的
  -- 这样 Prefer、Accept、Range 等 header 都能传递到 PostgREST
  local hop_by_hop = {
    ["connection"] = true,
    ["keep-alive"] = true,
    ["transfer-encoding"] = true,
    ["te"] = true,
    ["trailer"] = true,
    ["upgrade"] = true,
    ["proxy-authorization"] = true,
    ["proxy-connection"] = true,
  }

  local proxy_headers = {}
  for k, v in pairs(request_headers) do
    local lower_key = k:lower()
    if not hop_by_hop[lower_key]
       and lower_key ~= "host"
       and lower_key ~= "authorization" then
      -- 多值 header（Kong 可能返回 table），取第一个
      if type(v) == "table" then
        proxy_headers[k] = v[1]
      else
        proxy_headers[k] = v
      end
    end
  end

  -- 覆盖 SigV4 必需的 headers
  proxy_headers["Authorization"] = authorization_header
  proxy_headers["X-Amz-Date"] = timestamp
  proxy_headers["Host"] = function_url_host
  proxy_headers["Content-Type"] = request_headers["content-type"] or "application/json"

  if session_token then
    proxy_headers["X-Amz-Security-Token"] = session_token
  end

  -- Mint short-lived JWT from consumer role and set as X-Client-Authorization
  local consumer = kong.client.get_consumer()
  local role = "anon"
  if consumer and consumer.username then
    if consumer.username:match("%-%-service_role$") then
      role = "service_role"
    end
  end

  -- For anon consumers, check if Authorization header carries a valid GoTrue JWT
  local extra_claims = nil
  if role == "anon" then
    local auth_header = kong.request.get_header("Authorization")
    if auth_header then
      local bearer_token = auth_header:match("^[Bb]earer%s+(.+)$")
      if bearer_token and bearer_token:sub(1, 3) == "eyJ" then
        -- Looks like a JWT (not an opaque sb_ key), try to verify
        local claims, verify_err = verify_jwt(bearer_token, jwt_secret)
        if claims and claims.sub then
          -- Valid GoTrue JWT with sub claim
          -- Lua treats "" as truthy, so explicit check for empty string
          local jwt_role = claims.role
          if not jwt_role or jwt_role == "" then
            jwt_role = "authenticated"
          end
          -- Defense: reject service_role escalation via JWT
          if jwt_role == "service_role" then
            kong.log.warn("Rejected service_role escalation via JWT for project: ", project_id)
            jwt_role = "anon"
          end
          role = jwt_role
          -- Forward GoTrue claims to PostgREST
          extra_claims = {}
          local forward_keys = {
            "sub", "email", "phone", "aud", "role",
            "session_id", "is_anonymous", "aal", "amr",
            "app_metadata", "user_metadata",
          }
          for _, k in ipairs(forward_keys) do
            if claims[k] ~= nil then
              extra_claims[k] = claims[k]
            end
          end
          kong.log.debug("Authenticated user: sub=", claims.sub, ", role=", role, " for project: ", project_id)
        else
          -- Verification failed: graceful degradation to anon
          kong.log.debug("GoTrue JWT verification failed: ", verify_err or "unknown", ", using consumer role: anon for project: ", project_id)
        end
      end
    end
  end

  if not extra_claims then
    kong.log.debug("using consumer role: ", role, " for project: ", project_id)
  end

  local short_jwt = mint_jwt(project_id, role, jwt_secret, extra_claims)
  proxy_headers["X-Client-Authorization"] = "Bearer " .. short_jwt

  -- 发送 HTTP 请求到 Function URL
  local httpc = http.new()
  httpc:set_timeout(30000)  -- 30 秒超时

  local res, http_err = httpc:request_uri(target_url, {
    method = request_method,
    headers = proxy_headers,
    body = request_body,
    ssl_verify = true,
  })

  if not res then
    kong.log.err("Failed to proxy to Lambda Function URL: ", http_err)
    return kong.response.exit(502, { error = "Bad Gateway", message = http_err })
  end

  kong.log.debug("[route] Function URL response status: ", res.status)

  -- Skip upstream CORS headers — Kong CORS plugin manages these.
  -- Passing them through would cause duplicate Access-Control-* headers,
  -- which browsers reject outright.
  local cors_headers = {
    ["access-control-allow-origin"] = true,
    ["access-control-allow-methods"] = true,
    ["access-control-allow-headers"] = true,
    ["access-control-expose-headers"] = true,
    ["access-control-allow-credentials"] = true,
    ["access-control-max-age"] = true,
  }

  -- Set response headers from Lambda.
  -- resty.http returns multi-value headers (e.g. Set-Cookie) as Lua tables.
  -- Use set_header for the first value, then add_header for the rest to
  -- preserve all values (critical for Set-Cookie).
  for k, v in pairs(res.headers) do
    local lower_key = k:lower()
    if not cors_headers[lower_key] then
      if type(v) == "table" then
        kong.response.set_header(k, v[1])
        for i = 2, #v do
          kong.response.add_header(k, v[i])
        end
      else
        kong.response.set_header(k, v)
      end
    end
  end

  -- 添加路由信息
  kong.response.set_header("X-Routed-To-Project", project_id)
  kong.response.set_header("X-Routed-Via", "function-url")

  -- 直接返回 Function URL 的响应（标准 HTTP 响应，无需解包）
  return kong.response.exit(res.status, res.body)
end

return DynamicLambdaRouterHandler
