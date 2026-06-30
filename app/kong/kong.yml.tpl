_format_version: "3.0"
_transform: true

services:
  # ============================================
  # Health Check (ALB target group probe)
  # ============================================
  - name: health-check
    url: http://localhost:8000
    routes:
      - name: health-check-route
        paths:
          - /health
    plugins:
      - name: pre-function
        config:
          access:
            - |
              return kong.response.exit(200, '{"status":"ok"}', { ["Content-Type"] = "application/json" })

  # ============================================
  # Functions Service (Edge Functions Runtime)
  # ============================================
  - name: functions-service
    url: ${KONG_FUNCTIONS_SERVICE_URL}
    routes:
      - name: functions-route
        paths:
          - /functions/v1
        strip_path: true
    plugins:
      - name: cors
        config:
          origins:
            - "*"
          methods:
            - GET
            - POST
            - PUT
            - PATCH
            - DELETE
            - OPTIONS
          headers:
            - "*"
          exposed_headers:
            - "*"
          credentials: true
          max_age: 3600

      # Extract project-id from subdomain (domain-agnostic)
      - name: pre-function
        config:
          access:
            - |
              local host = kong.request.get_header("Host")
              local uri = kong.request.get_path()
              local project_id

              if host then
                host = host:gsub(":%d+$", "")
                local subdomain = host:match("^([^%.]+)%.")
                if subdomain and subdomain ~= "api" then
                  project_id = subdomain
                  kong.service.request.set_header("X-Project-ID", project_id)
                  kong.log.debug("Extracted project-id from subdomain: ", project_id)
                end
              end

              if project_id and uri:match("^/functions/v1/(.+)") then
                local slug = uri:match("^/functions/v1/(.+)")
                -- health 端点不添加 project_id
                if slug == "health" or slug == "main" then
                  kong.log.debug("Special endpoint detected, no path rewrite: ", slug)
                end
                -- 不需要重写路径，project_id 通过 header 传递
                kong.log.debug("Function request for project: ", project_id, " slug: ", slug)
              end

      - name: key-auth
        config:
          key_names:
            - apikey
          hide_credentials: false
          # Anonymous fallback: when no/invalid apikey is provided, key-auth
          # falls back to the platform-wide anonymous-public consumer (which
          # has ACL group 'anon'). Whether anonymous is allowed for a given
          # function is decided by the post-function plugin below, which
          # consults tenant-manager for that function's verify_jwt flag.
          anonymous: anonymous-public

      # Verify project ownership AND enforce per-function verify_jwt:
      # - Authenticated consumer ({ref}--anon / --service_role): require
      #   project match (existing behavior).
      # - Anonymous consumer (anonymous-public): allowed only if the function
      #   has verify_jwt=false. Looked up via tenant-manager internal endpoint.
      - name: post-function
        config:
          access:
            - |
              local http = require "resty.http"
              local cjson = require "cjson"
              local consumer = kong.client.get_consumer()
              local project_id = kong.request.get_header("X-Project-ID")
              local uri = kong.request.get_path()
              local slug = uri:match("^/functions/v1/([^/?]+)")

              local function deny(code, message)
                return kong.response.exit(code, { error = code == 401 and "Unauthorized" or "Forbidden", message = message })
              end

              if not project_id then
                return deny(401, "Project ID could not be derived from request")
              end

              if consumer and consumer.username == "anonymous-public" then
                -- Anonymous request — only permitted if the target function
                -- explicitly opts out of JWT verification.
                if not slug or slug == "health" or slug == "main" then
                  return deny(401, "API key required")
                end
                local tm_url = os.getenv("TENANT_MANAGER_URL") or "http://tenant-manager.supabase.local:3001"
                local httpc = http.new()
                httpc:set_timeout(2000)
                local res, err = httpc:request_uri(tm_url .. "/internal/v1/projects/" .. project_id .. "/functions/" .. slug, {
                  method = "GET",
                  headers = { ["Accept"] = "application/json" },
                })
                if not res or res.status ~= 200 then
                  kong.log.err("verify_jwt lookup failed for ", project_id, "/", slug, ": ", err or res and res.status)
                  return deny(401, "API key required")
                end
                local ok, body = pcall(cjson.decode, res.body)
                if not ok or body.verify_jwt ~= false then
                  return deny(401, "API key required")
                end
                kong.log.debug("Anonymous request allowed for verify_jwt=false function: ", project_id, "/", slug)
                return
              end

              if consumer and consumer.username and project_id then
                local consumer_project = consumer.username:match("^(.+)%-%-")
                if not consumer_project or consumer_project ~= project_id then
                  kong.log.err("API key project mismatch: consumer=", consumer.username, " requested_project=", project_id)
                  return deny(403, "API key does not belong to this project")
                end
                kong.log.debug("API key validated for project: ", project_id)
              end

      - name: acl
        config:
          allow:
            - anon
            - admin
          hide_groups_header: true

  # ============================================
  # Function Deploy (Function Management API)
  # DISABLED: Route temporarily disabled, uncomment to re-enable
  # ============================================
  # - name: function-deploy
  #   url: http://function-deploy.supabase.local:3000
  #   routes:
  #     - name: function-deploy-route
  #       paths:
  #         - /api/v1/projects
  #         - /api/v1/functions
  #         - /api/platform
  #       strip_path: false
  #   plugins:
  #     - name: cors
  #       config:
  #         origins:
  #           - "*"
  #         methods:
  #           - GET
  #           - POST
  #           - PUT
  #           - PATCH
  #           - DELETE
  #           - OPTIONS
  #         headers:
  #           - "*"
  #         exposed_headers:
  #           - "*"
  #         credentials: true
  #         max_age: 3600
  #
  #     # Extract project-id from subdomain
  #     - name: pre-function
  #       config:
  #         access:
  #           - |
  #             local host = kong.request.get_header("Host")
  #             local project_id = kong.request.get_header("X-Project-ID")
  #             local uri = kong.request.get_path()
  #
  #             if not project_id and host then
  #               host = host:gsub(":%d+$", "")
  #               local subdomain = host:match("^([^%.]+)%.")
  #               if subdomain and subdomain ~= "api" then
  #                 project_id = subdomain
  #                 kong.service.request.set_header("X-Project-ID", project_id)
  #                 kong.log.info("Extracted project-id from subdomain: ", project_id)
  #               end
  #             elseif project_id then
  #               kong.service.request.set_header("X-Project-ID", project_id)
  #               kong.log.info("Using existing X-Project-ID: ", project_id)
  #             end
  #
  #             if uri:match("^/api/v1/projects/[^/]+/") then
  #               local current_ref = uri:match("^/api/v1/projects/([^/]+)/")
  #               if current_ref and project_id and current_ref ~= project_id then
  #                 local new_path = uri:gsub("^/api/v1/projects/[^/]+/", "/api/v1/projects/" .. project_id .. "/")
  #                 kong.service.request.set_path(new_path)
  #                 kong.log.info("Rewritten API path from ", uri, " to ", new_path)
  #               end
  #             elseif uri:match("^/api/v1/functions") and project_id then
  #               local new_path = uri:gsub("^/api/v1/functions", "/api/v1/projects/" .. project_id .. "/functions")
  #               kong.service.request.set_path(new_path)
  #               kong.log.info("Added project prefix to function API path from ", uri, " to ", new_path)
  #             end
  #
  #     - name: key-auth
  #       config:
  #         key_names:
  #           - apikey
  #         hide_credentials: false
  #         anonymous: ~
  #
  #     # Validate API key belongs to the project
  #     - name: post-function
  #       config:
  #         access:
  #           - |
  #             local consumer = kong.client.get_consumer()
  #             local project_id = kong.request.get_header("X-Project-ID")
  #             
  #             if consumer and consumer.username and project_id then
  #               local consumer_project = consumer.username:match("^([^%-]+)")
  #               
  #               if consumer_project ~= project_id then
  #                 kong.log.err("API key project mismatch: consumer=", consumer.username, " requested_project=", project_id)
  #                 return kong.response.exit(403, {
  #                   error = "Forbidden",
  #                   message = "API key does not belong to this project"
  #                 })
  #               end
  #               
  #               kong.log.info("API key validated for project: ", project_id)
  #             end
  #
  #     - name: acl
  #       config:
  #         allow:
  #           - anon
  #           - admin
  #         hide_groups_header: true

  # ============================================
  # Storage Service (supabase/storage-api in MULTI_TENANT mode)
  # ============================================
  - name: storage-service
    url: ${KONG_STORAGE_SERVICE_URL}
    routes:
      - name: storage-route
        paths:
          - /storage/v1
        strip_path: true
    plugins:
      - name: cors
        config:
          origins:
            - "*"
          methods:
            - GET
            - POST
            - PUT
            - PATCH
            - DELETE
            - OPTIONS
            - HEAD
          headers:
            - "*"
          exposed_headers:
            - "*"
          credentials: true
          max_age: 3600

      # Extract project-id from subdomain into X-Project-ID. Our forked
      # storage-api/src/http/plugins/tenant-id.ts honours that header before
      # falling back to upstream's X-Forwarded-Host regex flow.
      - name: pre-function
        config:
          access:
            - |
              local host = kong.request.get_header("Host")
              if host then
                host = host:gsub(":%d+$", "")
                local subdomain = host:match("^([^%.]+)%.")
                if subdomain and subdomain ~= "api" then
                  kong.service.request.set_header("X-Project-ID", subdomain)
                  kong.log.debug("Storage: extracted project-id from subdomain: ", subdomain)
                end
              end

      - name: key-auth
        config:
          key_names:
            - apikey
          hide_credentials: false
          anonymous: ~

      # Project ownership + opaque-key → JWT mint.
      # storage-api validates JWT (HS256) against its tenant config, so we
      # exchange the caller's opaque apikey for a short-lived JWT here. The
      # tenant's jwt_secret is fetched from tenant-manager and cached in Kong
      # worker memory for cache_ttl seconds.
      - name: post-function
        config:
          access:
            - |
              local cjson = require "cjson"
              local http = require "resty.http"
              local hmac = require "resty.openssl.hmac"

              local consumer = kong.client.get_consumer()
              local project_id = kong.request.get_header("X-Project-ID")
              if not (consumer and consumer.username and project_id) then
                return
              end

              local consumer_project, role = consumer.username:match("^(.+)%-%-(.+)$")
              if not consumer_project or consumer_project ~= project_id then
                kong.log.err("Storage: API key project mismatch: consumer=", consumer.username, " requested_project=", project_id)
                return kong.response.exit(403, {
                  error = "Forbidden",
                  message = "API key does not belong to this project"
                })
              end

              -- Fetch jwt_secret (cached per worker, 5 min TTL).
              local cache = ngx.shared.kong or {}
              local cache_key = "storage:jwt:" .. project_id
              local jwt_secret
              if cache.get then
                jwt_secret = cache:get(cache_key)
              end
              if not jwt_secret then
                local httpc = http.new()
                httpc:set_timeout(2000)
                local tm_url = os.getenv("KONG_TENANT_MANAGER_URL") or "http://tenant-manager.supabase.local:3001"
                local res, err = httpc:request_uri(tm_url .. "/project/" .. project_id .. "/config", {
                  method = "GET",
                  headers = { ["Accept"] = "application/json" },
                })
                if not res or res.status ~= 200 then
                  kong.log.err("Storage: failed to fetch project config: ", err or (res and res.status))
                  return kong.response.exit(500, { error = "InternalError", message = "Failed to mint JWT" })
                end
                local ok, data = pcall(cjson.decode, res.body)
                if not ok or not data.jwt_secret then
                  return kong.response.exit(500, { error = "InternalError", message = "Project config missing jwt_secret" })
                end
                jwt_secret = data.jwt_secret
                if cache.set then
                  cache:set(cache_key, jwt_secret, 300)
                end
              end

              -- Mint short-lived HS256 JWT (5 min).
              local function b64url(s)
                local b = ngx.encode_base64(s)
                return b:gsub("+", "-"):gsub("/", "_"):gsub("=", "")
              end
              local jwt_role = role == "service_role" and "service_role" or "anon"
              local now = ngx.time()
              local header_b64 = b64url('{"alg":"HS256","typ":"JWT"}')
              local payload = cjson.encode({
                iss = "supabase",
                ref = project_id,
                role = jwt_role,
                iat = now,
                exp = now + 300,
              })
              local payload_b64 = b64url(payload)
              local signing_input = header_b64 .. "." .. payload_b64
              local h = hmac.new(jwt_secret, "SHA256")
              local sig = h:final(signing_input)
              local jwt = signing_input .. "." .. b64url(sig)

              -- Replace upstream Authorization with the minted JWT (apikey
              -- header is left untouched so storage-api sees it for logging).
              kong.service.request.set_header("Authorization", "Bearer " .. jwt)
              kong.service.request.set_header("apikey", jwt)
              kong.log.debug("Storage: minted JWT for project=", project_id, " role=", jwt_role)

      - name: acl
        config:
          allow:
            - anon
            - admin
          hide_groups_header: true

  # ============================================
  # Auth Service (GoTrue)
  # ============================================
  - name: auth-service
    url: ${KONG_AUTH_SERVICE_URL}
    # CORS applies to every auth route (shared, no auth dependency).
    plugins:
      - name: cors
        config:
          origins:
            - "*"
          methods:
            - GET
            - POST
            - PUT
            - PATCH
            - DELETE
            - OPTIONS
          headers:
            - "*"
          exposed_headers:
            - "*"
          credentials: true
          max_age: 3600
    routes:
      # ----------------------------------------------------------------
      # Public auth callbacks — hit directly by browsers / external IdPs
      # (Google OAuth redirect, email confirmation links, SAML ACS) which
      # cannot carry an apikey. These MUST NOT require key-auth. The
      # subdomain -> X-Tenant-Id injection is still applied so GoTrue
      # resolves the right tenant. These paths are more specific than the
      # plain `/auth/v1` route, so Kong matches them here first.
      #
      # strip_path is FALSE here: stripping the full matched path (e.g.
      # `/auth/v1/callback`) would forward `/` to GoTrue (404). Instead the
      # pre-function strips only the `/auth/v1` prefix via set_path, so
      # GoTrue receives `/callback`, `/verify`, etc.
      # ----------------------------------------------------------------
      - name: auth-public-route
        paths:
          - /auth/v1/callback
          - /auth/v1/verify
          - /auth/v1/sso/saml/acs
          - /auth/v1/sso/saml/metadata
        strip_path: false
        plugins:
          - name: pre-function
            config:
              access:
                - |
                  -- Strip the fixed-length "/auth/v1" (8 chars) prefix so
                  -- GoTrue sees /callback etc. sub(9) avoids the pattern engine.
                  local path = kong.request.get_path()
                  local stripped = path:sub(9)
                  if stripped == "" then stripped = "/" end
                  kong.service.request.set_path(stripped)

                  -- Resolve tenant from subdomain (mirrors auth-route below).
                  -- match stops at the first dot, so a trailing :port is ignored.
                  local host = kong.request.get_header("Host")
                  if host then
                    local subdomain = host:match("^([^%.]+)%.")
                    if subdomain and subdomain ~= "api" then
                      kong.service.request.set_header("X-Project-ID", subdomain)
                      kong.service.request.set_header("X-Tenant-Id", subdomain)
                      kong.log.debug("Extracted project-id from subdomain: ", subdomain)
                    end
                  end

      # ----------------------------------------------------------------
      # All other /auth/v1 endpoints require a project apikey.
      # ----------------------------------------------------------------
      - name: auth-route
        paths:
          - /auth/v1
        strip_path: true
        plugins:
          - name: pre-function
            config:
              access:
                - |
                  -- Resolve tenant from subdomain (mirrors auth-public-route above).
                  -- match stops at the first dot, so a trailing :port is ignored.
                  local host = kong.request.get_header("Host")
                  if host then
                    local subdomain = host:match("^([^%.]+)%.")
                    if subdomain and subdomain ~= "api" then
                      kong.service.request.set_header("X-Project-ID", subdomain)
                      kong.service.request.set_header("X-Tenant-Id", subdomain)
                      kong.log.debug("Extracted project-id from subdomain: ", subdomain)
                    end
                  end

          - name: key-auth
            config:
              key_names:
                - apikey
              hide_credentials: false
              anonymous: ~

          # Validate API key belongs to the project (runs after key-auth)
          - name: post-function
            config:
              access:
                - |
                  local consumer = kong.client.get_consumer()
                  local project_id = kong.request.get_header("X-Project-ID")

                  if consumer and consumer.username and project_id then
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

          - name: acl
            config:
              allow:
                - anon
                - admin
              hide_groups_header: true

  - name: tenant-manager
    url: ${KONG_TENANT_MANAGER_URL}
    read_timeout: 180000
    write_timeout: 180000
    connect_timeout: 10000
    routes:
      - name: tenant-manager-route
        paths:
          - /project
          - /admin
        strip_path: false

  - name: postgrest-lambda-service
    url: http://localhost:9999  # Dummy URL, overridden by dynamic-lambda-router plugin
    routes:
      - name: postgrest-lambda-route
        paths:
          - /rest/v1/
        strip_path: true
    plugins:
      - name: cors
        config:
          origins:
            - "*"
          methods:
            - GET
            - POST
            - PUT
            - PATCH
            - DELETE
            - OPTIONS
          headers:
            - "*"
          exposed_headers:
            - "*"
          credentials: true
          max_age: 3600

      # Extract project-id from subdomain (domain-agnostic)
      - name: pre-function
        config:
          access:
            - |
              local host = kong.request.get_header("Host")

              if host then
                host = host:gsub(":%d+$", "")
                local subdomain = host:match("^([^%.]+)%.")
                if subdomain and subdomain ~= "api" then
                  kong.service.request.set_header("X-Project-ID", subdomain)
                  kong.log.debug("Extracted project-id from subdomain: ", subdomain)
                end
              end

      - name: key-auth
        config:
          key_names:
            - apikey
          hide_credentials: true
          anonymous: ~

      - name: acl
        config:
          allow:
            - anon
            - admin
          hide_groups_header: true

      # Consumer-project binding validation is inside dynamic-lambda-router handler.lua
      # (post-function priority=-1000 would never execute before dynamic-lambda-router short-circuits)
      - name: dynamic-lambda-router
        config:
          project_service_url: "${KONG_TENANT_MANAGER_URL}"
          project_header: "X-Project-ID"
          cache_ttl: 300
          aws_region: "${KONG_AWS_REGION}"
      - name: aws-lambda
        config:
          aws_region: ${KONG_AWS_REGION}
          function_name: postgrest-api
          invocation_type: RequestResponse
          log_type: Tail
          is_proxy_integration: true
          awsgateway_compatible: true
          forward_request_body: true
          forward_request_headers: true
          forward_request_method: true
          forward_request_uri: true
