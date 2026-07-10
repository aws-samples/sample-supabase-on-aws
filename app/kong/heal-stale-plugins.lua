-- heal-stale-plugins.lua
--
-- Idempotently remove stale SERVICE-level auth plugins from auth-service and
-- storage-service. Both moved their auth plugins (key-auth/acl/post-function)
-- from SERVICE level down to ROUTE level so public endpoints (OAuth callbacks,
-- storage signed/public URLs) hit directly by browsers are not gated by
-- key-auth. Kong runs DB-backed and `kong config db_import` is an incremental
-- upsert that never deletes removed entities, so on an upgraded environment the
-- old service-level key-auth survives and keeps gating ALL routes -> 401.
--
-- This deletes leftover SERVICE-level auth plugins via the Admin API. It is:
--   * idempotent  — a clean install (service-level = only cors) deletes nothing
--   * narrow      — only these services, only the SERVICE level, only the listed
--                   auth plugins; never touches cors, route-level plugins, or
--                   consumers/credentials (so tenant apikeys are never harmed)
--   * fail-open   — any error logs and exits 0; it must never block Kong startup
--
-- Run via: resty /heal-stale-plugins.lua   (resty ships in the kong image).

local ADMIN = os.getenv("KONG_ADMIN_INTERNAL_URL") or "http://localhost:8001"
-- Services whose auth plugins were moved from SERVICE level to ROUTE level.
local SERVICE_NAMES = { "auth-service", "storage-service" }
-- Plugins that, post-migration, must only ever live at the ROUTE level.
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

-- Clean one service's stale service-level plugins. Per-service failures are
-- non-fatal: log and skip (return) so the remaining services are still
-- processed. Only a missing resty.http/cjson dependency bails the whole run.
local function heal_service(service_name)
  local res, err = admin_request("GET", "/services/" .. service_name .. "/plugins")
  if not res then
    log("skipped " .. service_name .. " (non-fatal): cannot reach Admin API: " .. tostring(err))
    return
  end
  if res.status ~= 200 then
    -- 404 = service not present yet (nothing to heal); treat as clean.
    log("skipped " .. service_name .. " (non-fatal): GET plugins returned HTTP " .. res.status)
    return
  end

  local body = cjson.decode(res.body)
  if not body or type(body.data) ~= "table" then
    log("skipped " .. service_name .. " (non-fatal): unexpected plugins payload")
    return
  end

  local removed = 0
  for _, plugin in ipairs(body.data) do
    if STALE_AT_SERVICE_LEVEL[plugin.name] and plugin.id then
      local del, derr = admin_request("DELETE", "/plugins/" .. plugin.id)
      if del and (del.status == 204 or del.status == 200) then
        removed = removed + 1
        log("Removed stale service-level plugin from " .. service_name .. ": " ..
          plugin.name .. " (" .. plugin.id .. ")")
      else
        -- Non-fatal: log and keep going; a leftover is better than a dead gateway.
        log("WARN failed to delete " .. plugin.name .. " on " .. service_name .. " -> " ..
          (del and ("HTTP " .. del.status) or tostring(derr)))
      end
    end
  end

  if removed == 0 then
    log("no stale service-level auth plugins on " .. service_name .. " (nothing to do)")
  else
    log("done; removed " .. removed .. " stale service-level plugin(s) from " .. service_name)
  end
end

for _, service_name in ipairs(SERVICE_NAMES) do
  heal_service(service_name)
end
os.exit(0)
