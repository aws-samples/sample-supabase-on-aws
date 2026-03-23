// Multi-level Edge Function: api/users
import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'

serve((req: Request) => {
  const method = req.method
  const url = new URL(req.url)
  
  return new Response(JSON.stringify({
    message: 'Enhanced Edge Functions - Multi-level directory support working!',
    path: 'api/users',
    method: method,
    timestamp: new Date().toISOString(),
    url: url.pathname
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  })
})