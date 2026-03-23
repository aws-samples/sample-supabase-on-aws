// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
interface reqPayload {
  name: string;
}

console.info('server started');

Deno.serve(async (req: Request) => {
  const { name }: reqPayload = await req.json();
  const data = {
    message: `Hello ${name}!`,
  };

  return new Response(
    JSON.stringify(data),
    { headers: { 'Content-Type': 'application/json', 'Connection': 'keep-alive' }}
  );
});