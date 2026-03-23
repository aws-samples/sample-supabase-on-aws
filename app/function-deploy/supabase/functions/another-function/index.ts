// Another Function Edge Function
import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'

serve((req: Request) => {
  const method = req.method
  const url = new URL(req.url)
  
  // Get environment variables
  const functionEnv = Deno.env.get('ANOTHER_MESSAGE') || 'Default Another'
  const projectEnv = Deno.env.get('PROJECT_NAME') || 'Unknown Project'
  
  return new Response(JSON.stringify({
    message: functionEnv,
    project: projectEnv,
    function: 'another-function',
    method: method,
    timestamp: new Date().toISOString(),
    url: url.pathname,
    type: 'single-level-function'
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  })
})