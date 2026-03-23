local typedefs = require "kong.db.schema.typedefs"

return {
  name = "dynamic-lambda-router",
  fields = {
    {
      config = {
        type = "record",
        fields = {
          {
            project_service_url = {
              type = "string",
              default = "http://tenant-manager.supabase.local:3001",
              required = true,
              description = "Project service URL for config and function URL lookups"
            }
          },
          {
            project_header = {
              type = "string",
              default = "X-Project-ID",
              required = true,
              description = "Header name containing project ID"
            }
          },
          {
            cache_ttl = {
              type = "number",
              default = 300,
              required = true,
              description = "Cache TTL in seconds for function URL lookups"
            }
          },
          {
            aws_region = {
              type = "string",
              default = "us-east-1",
              required = true,
              description = "AWS region for SigV4 signing and Lambda Function URL calls"
            }
          }
        }
      }
    }
  }
}
