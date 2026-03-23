-- Schema for AWS Lambda SigV4 Authentication Plugin

local typedefs = require "kong.db.schema.typedefs"

return {
  name = "aws-lambda-sigv4",
  fields = {
    { protocols = typedefs.protocols_http },
    { config = {
        type = "record",
        fields = {
          { aws_region = {
              type = "string",
              default = "us-east-1",
              description = "AWS Region (will be auto-detected from Lambda URL if not provided)"
            }
          },
        },
      },
    },
  },
}
