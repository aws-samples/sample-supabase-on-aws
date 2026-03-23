# Functions Service

Edge Functions service that extracts and returns project ID from HTTP headers.

## CDK Deployment

This directory contains AWS CDK code to deploy the Functions service with EFS storage.

### Prerequisites

1. Deploy the main infrastructure stack first (`/infra`)
2. Ensure you have AWS credentials configured
3. Install CDK dependencies:
   ```bash
   npm install
   ```

### Configuration

Copy `.env.example` to `.env` and fill in the values from your infrastructure deployment:

```bash
cp .env.example .env
```

Required parameters (get these from the infra stack outputs):
- `VPC_ID` - VPC ID from infra stack
- `SUBNET_IDS` - Comma-separated subnet IDs
- `SECURITY_GROUP_ID` - Security group for Functions service
- `KONG_SECURITY_GROUP_ID` - Kong security group ID
- `CLUSTER_NAME` - ECS cluster name
- `TASK_ROLE_ARN` - ECS task role ARN
- `EXECUTION_ROLE_ARN` - ECS task execution role ARN
- `SERVICE_DISCOVERY_ID` - Service discovery service ID

Note: `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` are automatically detected by CDK from your AWS credentials.

### Deploy

```bash
# Deploy with new service
cdk deploy --context createNewService=true

# Deploy without creating service (EFS only)
cdk deploy
```

### What Gets Deployed

- **EFS File System**: Encrypted storage for edge functions
- **EFS Access Point**: Mount point for functions
- **ECS Task Definition**: Functions service container configuration
- **ECS Service** (optional): Fargate service with auto-scaling
- **Security Group Rules**: Allow Kong to access Functions service

---

## Features

- ✅ Extracts `X-Project-ID` from request headers
- ✅ Returns project information in JSON format
- ✅ Supports all HTTP methods (GET, POST, PUT, PATCH, DELETE)
- ✅ Provides health check endpoint
- ✅ Self-documenting API

## API Endpoints

### 1. Health Check
```bash
GET /functions/v1/health
```

**Example:**
```bash
curl -k https://<project-ref>.example.com/functions/v1/health
```

**Response (200 OK):**
```json
{
  "message": "Functions ready"
}
```

### 2. Functions Endpoint
```bash
GET/POST /functions/v1/<function-name>
Header: apikey: <your-api-key>
```

**Example:**
```bash
curl -k -H "apikey: <your-api-key>" \
  https://<project-ref>.example.com/functions/v1/main
```

**Response:**
```json
{
  "service": "Functions Service",
  "message": "Function executed successfully",
  "function_name": "main",
  "method": "GET",
  "path": "/functions/v1/main",
  "timestamp": "2026-02-26T10:49:00.000000"
}
```

### 3. Functions with Different Methods
```bash
# GET request
curl -k -H "apikey: <your-api-key>" \
  https://<project-ref>.example.com/functions/v1/<function-name>

# POST request with body
curl -k -X POST \
  -H "apikey: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}' \
  https://<project-ref>.example.com/functions/v1/<function-name>
```

## Local Development

### Run with Python
```bash
# Install dependencies
pip install -r requirements.txt

# Run the application
python app.py
```

### Run with Docker
```bash
# Build the image
docker build -t functions-service .

# Run the container
docker run -p 8080:8080 functions-service

# Test locally
curl -H "apikey: test-api-key" http://localhost:8080/functions/v1/main
```

## Integration with Kong Gateway

This service is designed to work with Kong's dynamic routing. Kong validates the API key and routes requests to the appropriate project's functions.

### Request Flow:
1. Client sends request with `apikey` header
2. Kong validates API key and extracts project reference
3. Kong routes to project-specific subdomain: `https://<project-ref>.example.com`
4. Request forwarded to Functions service on port 8080

### Kong Configuration Example:
```yaml
services:
  - name: functions-service
    url: http://functions-service.kong.local:8080
    routes:
      - name: functions-route
        paths:
          - /functions/v1
        strip_path: false
    plugins:
      - name: key-auth
        config:
          key_names: ["apikey"]
      - name: cors
        config:
          origins: ["*"]
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
```

## Error Handling

### Missing API Key
```json
{
  "error": "Missing apikey header",
  "message": "Please provide apikey in request headers",
  "example": {
    "header": "apikey",
    "value": "sb_publishable_xxx"
  }
}
```

### Invalid API Key
```json
{
  "error": "Unauthorized",
  "message": "Invalid API key"
}
```

## Environment Variables

- `PORT` - Server port (default: 8080)

## Deployment

This service can be deployed to:
- AWS ECS Fargate
- Kubernetes
- Docker Swarm
- Any container platform

## Technology Stack

- **Framework**: Flask 3.0.0
- **WSGI Server**: Gunicorn 21.2.0
- **Python**: 3.11
- **Container**: Docker

## Health Monitoring

The service includes a health check endpoint that can be used by:
- Load balancers (ALB, NLB)
- Container orchestrators (ECS, Kubernetes)
- Monitoring systems

Health check configuration:
- Interval: 30 seconds
- Timeout: 3 seconds
- Retries: 3
