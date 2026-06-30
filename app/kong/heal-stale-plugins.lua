-- heal-stale-plugins.lua
--
-- Idempotently remove stale SERVICE-level auth plugins left on auth-service.
--
-- Why: Kong runs DB-backed and the entrypoint imports config with
-- `kong config db_import`, which is an incremental upsert that never deletes
-- entities removed from the declarative file. Commit 13cfc94 moved the auth
-- plugins (key-auth/acl/post-function) from the SERVICE level down to the
-- auth-route ROUTE level so the public OAuth callbacks (/auth/v1/callback,
-- /verify, /sso/saml/acs, /sso/saml/metadata) are not gated by key-auth.
-- On an environment that previously ran the old (service-level) config, the
-- stale service-level key-auth survives db_import and keeps gating ALL routes
-- under auth-service — including the public ones — yielding 401.
--
-- This script deletes any leftover SERVICE-level plugin in the auth allow-list
-- via the Admin API. It is:
--   * idempotent  — a clean install (service-level = only cors) deletes nothing
--   * narrow      — only auth-service, only the SERVICE level, only the listed
--                   auth plugins; never touches cors, route-level plugins, or
--                   consumers/credentials (so tenant apikeys are never harmed)
--   * fail-open   — any error logs and exits 0; it must never block Kong startup
--
-- Run via: resty /heal-stale-plugins.lua   (resty ships in the kong image;
-- cjson + resty.http are both available — verified).

local ADMIN = os.getenv("KONG_ADMIN_INTERNAL_URL") or "http://localhost:8001"
local SERVICE_NAME = "auth-service"
-- Plugins that, post-13cfc94, must only ever live at the ROUTE level.
local STALE_AT_SERVICE_LEVEL = {
  ["key-auth"] = true,
  ["acl"] = true,
  ["post-function"] = true,
}

local function log(msg)
  print("[heal-stale-plugins] " .. msg)
end

-- Fail-open wrapper: log the reason and exit 0 so Kong startup is never blocked.
local function bail(reason)
  log("skipped (non-fatal): " .. tostring(reason))
  os.exit(0)
end

local ok, http = pcall(require, "resty.http")
if not ok then bail("resty.http unavailable") end
local cjson
ok, cjson = pcall(require, "cjson.safe")
if not ok then bail("cjson unavailable") end

local function admin_request(method, path)
  local httpc = http.new()
  httpc:set_timeout(5000)
  local res, err = httpc:request_uri(ADMIN .. path, {
    method = method,
    headers = { ["Content-Type"] = "application/json" },
  })
  if not res then return nil, err end
  return res
end

-- Resolve and clean the auth-service's service-level plugins.
local res, err = admin_request("GET", "/services/" .. SERVICE_NAME .. "/plugins")
if not res then bail("cannot reach Admin API: " .. tostring(err)) end
if res.status ~= 200 then
  -- 404 = auth-service not present yet (nothing to heal); treat as clean.
  bail("GET plugins returned HTTP " .. res.status)
end

local body = cjson.decode(res.body)
if not body or type(body.data) ~= "table" then bail("unexpected plugins payload") end

local removed = 0
for _, plugin in ipairs(body.data) do
  if STALE_AT_SERVICE_LEVEL[plugin.name] and plugin.id then
    local del, derr = admin_request("DELETE", "/plugins/" .. plugin.id)
    if del and (del.status == 204 or del.status == 200) then
      removed = removed + 1
      log("Removed stale service-level plugin: " .. plugin.name .. " (" .. plugin.id .. ")")
    else
      -- Non-fatal: log and keep going; a leftover is better than a dead gateway.
      log("WARN failed to delete " .. plugin.name .. " -> " ..
        (del and ("HTTP " .. del.status) or tostring(derr)))
    end
  end
end

if removed == 0 then
  log("no stale service-level auth plugins on " .. SERVICE_NAME .. " (nothing to do)")
else
  log("done; removed " .. removed .. " stale service-level plugin(s) from " .. SERVICE_NAME)
end
os.exit(0)
