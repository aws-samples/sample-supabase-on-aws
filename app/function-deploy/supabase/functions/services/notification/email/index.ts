// Deep nested Edge Function: services/notification/email
import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'

serve((req: Request) => {
  const method = req.method
  const url = new URL(req.url)
  
  // Get environment variables
  const emailProvider = Deno.env.get('EMAIL_PROVIDER') || 'default'
  const projectEnv = Deno.env.get('PROJECT_NAME') || 'Unknown Project'
  
  return new Response(JSON.stringify({
    message: 'Email Notification Service',
    project: projectEnv,
    function: 'services/notification/email',
    method: method,
    timestamp: new Date().toISOString(),
    url: url.pathname,
    type: 'deep-nested-function',
    depth: 3,
    emailProvider: emailProvider,
    note: 'This demonstrates email service in nested structure'
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  })
})