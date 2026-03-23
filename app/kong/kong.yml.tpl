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
          anonymous: ~

      # Validate API key belongs to the project (runs after key-auth)
      - name: post-function
        config:
          access:
            - |
              local consumer = kong.client.get_consumer()
              local project_id = kong.request.get_header("X-Project-ID")
              
              if consumer and consumer.username and project_id then
                -- Extract project from consumer username (format: {projectRef}--{role})
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
  # Auth Service (GoTrue)
  # ============================================
  - name: auth-service
    url: ${KONG_AUTH_SERVICE_URL}
    routes:
      - name: auth-route
        paths:
          - /auth/v1
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

      - name: pre-function
        config:
          access:
            - |
              local host = kong.request.get_header("Host")
              local project_id

              if host then
                host = host:gsub(":%d+$", "")
                local subdomain = host:match("^([^%.]+)%.")
                if subdomain and subdomain ~= "api" then
                  project_id = subdomain
                  kong.service.request.set_header("X-Project-ID", project_id)
                  kong.service.request.set_header("X-Tenant-Id", project_id)
                  kong.log.debug("Extracted project-id from subdomain: ", project_id)
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
