-- AWS Lambda SigV4 Authentication Plugin for Kong
-- Uses ECS Task Role for credentials (no hardcoded keys)

local aws = require("resty.aws")
local resty_sha256 = require("resty.sha256")
local str = require("resty.string")
local openssl_hmac = require("resty.openssl.hmac")

local ngx = ngx
local kong = kong
local fmt = string.format
local concat = table.concat
local sort = table.sort

local AwsLambdaSigV4Handler = {}

AwsLambdaSigV4Handler.PRIORITY = 1000
AwsLambdaSigV4Handler.VERSION = "1.0.0"

-- Initialize AWS SDK once
local AWS_INSTANCE
local function initialize_aws()
  if not AWS_INSTANCE then
    AWS_INSTANCE = aws()
    kong.log.info("AWS SDK initialized - using ECS Task Role")
  end
  return AWS_INSTANCE
end

-- Helper functions
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

local function create_canonical_request(method, uri, query_string, headers, payload_hash)
  local canonical_uri = uri or "/"
  local canonical_querystring = query_string or ""

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


function AwsLambdaSigV4Handler:access(conf)
  kong.log.info("AWS Lambda SigV4 plugin executing with ECS Task Role")

  -- Initialize AWS SDK and get credentials from ECS Task Role
  local aws_instance = initialize_aws()
  local credentials = aws_instance.config.credentials

  if not credentials then
    kong.log.err("Failed to get credentials provider")
    return kong.response.exit(500, { message = "Failed to get AWS credentials provider" })
  end

  -- Fetch actual credentials from Task Role
  local success, err = credentials:get()
  if not success then
    kong.log.err("Failed to fetch credentials: ", tostring(err))
    return kong.response.exit(500, { message = "Failed to fetch AWS credentials from Task Role" })
  end

  kong.log.info("Successfully obtained credentials from ECS Task Role")

  -- Access credentials from the credentials object itself
  local access_key = credentials.access_key
  local secret_key = credentials.secret_key
  local session_token = credentials.session_token

  -- Get request details
  local method = kong.request.get_method()
  local path = kong.request.get_path()
  local query_string = kong.request.get_raw_query() or ""
  local body = kong.request.get_raw_body() or ""
  local host = kong.request.get_forwarded_host()

  -- Get region
  local region = conf.aws_region or "us-east-1"

  -- Prepare signing parameters
  local timestamp = get_iso_timestamp()
  local date_stamp = get_date_stamp()
  local service = "lambda"
  local algorithm = "AWS4-HMAC-SHA256"
  local credential_scope = date_stamp .. "/" .. region .. "/" .. service .. "/aws4_request"

  -- Hash payload
  local payload_hash = sha256_hex(body)

  -- Prepare headers for signing
  local headers_to_sign = {
    host = host,
    ["x-amz-date"] = timestamp,
  }

  -- Add session token if present
  if session_token then
    headers_to_sign["x-amz-security-token"] = session_token
  end

  -- Create canonical request
  local canonical_request, signed_headers = create_canonical_request(
    method,
    path,
    query_string,
    headers_to_sign,
    payload_hash
  )

  -- Create string to sign
  local canonical_request_hash = sha256_hex(canonical_request)
  local string_to_sign = concat({
    algorithm,
    timestamp,
    credential_scope,
    canonical_request_hash
  }, "\n")

  -- Calculate signature using credentials from Task Role
  local signing_key = get_signature_key(secret_key, date_stamp, region, service)
  local signature = str.to_hex(hmac_sha256(signing_key, string_to_sign))

  -- Create authorization header
  local authorization_header = fmt(
    "%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
    algorithm,
    access_key,
    credential_scope,
    signed_headers,
    signature
  )

  -- Add headers to upstream request
  kong.service.request.set_header("Authorization", authorization_header)
  kong.service.request.set_header("X-Amz-Date", timestamp)
  kong.service.request.set_header("Host", host)

  if session_token then
    kong.service.request.set_header("X-Amz-Security-Token", session_token)
  end

  kong.log.info("AWS SigV4 signature added successfully using ECS Task Role")
end


return AwsLambdaSigV4Handler
