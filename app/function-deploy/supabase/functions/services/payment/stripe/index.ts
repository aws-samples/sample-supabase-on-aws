// Deep nested Edge Function: services/payment/stripe
import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'

serve((req: Request) => {
  const method = req.method
  const url = new URL(req.url)
  
  // Get environment variables
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') || 'sk_test_default'
  const projectEnv = Deno.env.get('PROJECT_NAME') || 'Unknown Project'
  
  return new Response(JSON.stringify({
    message: 'Stripe Payment Service',
    project: projectEnv,
    function: 'services/payment/stripe',
    method: method,
    timestamp: new Date().toISOString(),
    url: url.pathname,
    type: 'deep-nested-function',
    depth: 3,
    stripeKeyPrefix: stripeKey.substring(0, 10) + '...',
    note: 'This demonstrates 3-level deep directory structure'
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  })
})