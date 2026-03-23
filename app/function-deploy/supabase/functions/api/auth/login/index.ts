// Deep nested Edge Function: api/auth/login
import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'

serve((req: Request) => {
  const method = req.method
  const url = new URL(req.url)
  
  return new Response(JSON.stringify({
    message: 'Deep nested Edge Function working!',
    path: 'api/auth/login',
    method: method,
    timestamp: new Date().toISOString(),
    url: url.pathname,
    depth: 3,
    note: 'This demonstrates 3-level deep directory structure support'
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  })
})