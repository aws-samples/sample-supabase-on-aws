import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req: Request) => {
  const { name } = await req.json().catch(() => ({ name: "World" }));
  
  return new Response(
    JSON.stringify({
      message: `Hello, ${name}!`,
      timestamp: new Date().toISOString(),
      version: "1.0.0"
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});