// @ts-nocheck - This is a Deno Edge Function, not a Node.js module
import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'

serve((_req: Request) => {
  return new Response(
    JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  )
})
