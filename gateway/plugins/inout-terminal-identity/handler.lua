-- TLS validation belongs to Kong's TLS listener. Never trust certificate
-- identity supplied by a caller, including callers on the Docker network.
local Handler = { PRIORITY = 10000, VERSION = "1.5.0" }

local function bounded_body()
  -- Read native body metadata; get_headers() truncates after 100 fields and
  -- would let late Content-Length/Transfer-Encoding headers skip admission.
  local length = tonumber(ngx.var.content_length)
  if not ngx.var.http_transfer_encoding and (not length or length == 0) then return end
  -- Start the deadline before any lower-priority plugin or proxy buffering
  -- reads a chunked body. Native NGINX limits still cap buffered bytes.
  local deadline = tonumber(os.getenv("INOUT_UPLOAD_DEADLINE_SECONDS")) or 30
  if deadline <= 0 or deadline > 120 then deadline = 30 end
  local reader = ngx.thread.spawn(function()
    ngx.req.read_body()
    return "complete"
  end)
  local timer = ngx.thread.spawn(function()
    ngx.sleep(deadline)
    return "timeout"
  end)
  local ok, result = ngx.thread.wait(reader, timer)
  ngx.thread.kill(reader)
  ngx.thread.kill(timer)
  if not ok or result ~= "complete" then
    -- Do not drain an unfinished body or keep this HTTP/1 connection alive.
    return kong.response.exit(408, { message = "Request body timed out" }, { ["Connection"] = "close" })
  end
end

local function public_identity_path(path)
  -- Inspect both the original URI and Kong's normalized path. Decode once,
  -- then reject ambiguous forms instead of depending on upstream decoding,
  -- dot-segment removal, or matrix-parameter handling matching the proxy.
  path = ngx.unescape_uri(path)
  if path:find("[%%;\\%c]") or path:find("//", 1, true) then return false end
  for segment in path:gmatch("[^/]+") do
    if segment == "." or segment == ".." then return false end
  end
  -- SCIM is another delegated user-management API beneath /realms and is
  -- supported by default in Keycloak 26.8. Keep it on maintenance/internal
  -- routes even if an operator later enables it in the realm settings.
  local lower = string.lower(path)
  if lower:find("^/realms/[^/]+/scim/") or lower:find("^/realms/[^/]+/scim$") then return false end
  -- Keycloak's public OIDC/account endpoints and their assets. All other
  -- roots, including Admin REST, Admin Console, health and metrics, stay
  -- internal even when the caller possesses a realm-management bearer token.
  return path:find("^/realms/") or path:find("^/resources/") or path:find("^/%.well%-known/")
end

local function internal_path(path)
  -- Block the private callback on every listener, including web and temporary
  -- identity maintenance routes. Inspect decoding and canonical segments before
  -- an upstream framework gets a chance to reinterpret the path.
  for _ = 1, 3 do
    local decoded = ngx.unescape_uri(path)
    if decoded == path then break end
    path = decoded
  end
  path = path:gsub("\\", "/"):gsub(";[^/]*", "")
  local segments = {}
  for segment in path:gmatch("[^/]+") do
    if segment == ".." then
      segments[#segments] = nil
    elseif segment ~= "." then
      segments[#segments + 1] = segment
    end
  end
  return segments[1] and string.lower(segments[1]) == "internal"
end

local function normalized_route_path(path)
  -- Recognize aliases before rejecting them. A framework may decode escapes,
  -- remove dot segments or collapse repeated slashes before its auth handler.
  for _ = 1, 3 do
    local decoded = ngx.unescape_uri(path)
    if decoded == path then break end
    path = decoded
  end
  path = path:gsub("\\", "/"):gsub(";[^/]*", "")
  local segments = {}
  for segment in path:gmatch("[^/]+") do
    if segment == ".." then
      segments[#segments] = nil
    elseif segment ~= "." then
      segments[#segments + 1] = segment
    end
  end
  return "/" .. table.concat(segments, "/")
end

local function login_action_path(path)
  path = normalized_route_path(path)
  return path == "/login" or path:find("^/api/auth/callback$") or
    path:find("^/api/auth/callback/") or path:find("^/api/auth/signin$") or
    path:find("^/api/auth/signin/")
end

local function identity_login_action_path(path)
  path = normalized_route_path(path)
  return path:find("^/realms/[^/]+/login%-actions$") or
    path:find("^/realms/[^/]+/login%-actions/")
end

local function noncanonical_path(path)
  if path:find("[%%;\\%c]") or path:find("//", 1, true) then return true end
  for segment in path:gmatch("[^/]+") do
    if segment == "." or segment == ".." then return true end
  end
  return false
end

function Handler:rewrite()
  -- Kong 3.9's HTTP net.dst.port can reflect the Host header's port.
  -- Route using the actual socket instead, overwriting any caller value.
  ngx.req.set_header("InoutListener", ngx.var.server_port)
  local raw_path = ngx.var.request_uri:match("^[^?]*")
  if internal_path(raw_path) then
    return kong.response.exit(404, { message = "Not found" })
  end
  local port = ngx.var.server_port
  if port == "8000" and ngx.req.get_method() == "POST" and
     login_action_path(raw_path) and noncanonical_path(raw_path) then
    return kong.response.exit(400, { message = "Noncanonical login path" })
  end
  if port == "8005" and ngx.req.get_method() == "POST" and
     identity_login_action_path(raw_path) and noncanonical_path(raw_path) then
    return kong.response.exit(400, { message = "Noncanonical identity login path" })
  end
  if port == "8002" or port == "8443" then
    -- FastAPI decodes reserved escapes that expression routing preserves.
    -- API paths are static ASCII/UUID segments; reject alternate spellings
    -- before they can select an ordinary rather than sensitive-action quota.
    if raw_path:find("[%%;\\%c]") or raw_path:find("//", 1, true) then
      return kong.response.exit(400, { message = "Noncanonical API path" })
    end
    for segment in raw_path:gmatch("[^/]+") do
      if segment == "." or segment == ".." then
        return kong.response.exit(400, { message = "Noncanonical API path" })
      end
    end
  end
end

function Handler:access()
  local raw_path = ngx.var.request_uri:match("^[^?]*")
  if internal_path(raw_path) or internal_path(kong.request.get_path()) then
    return kong.response.exit(404, { message = "Not found" })
  end
  if ngx.var.server_port == "8005" then
    if not public_identity_path(raw_path) or not public_identity_path(kong.request.get_path()) then
      return kong.response.exit(404, { message = "Not found" })
    end
  end

  bounded_body()

  kong.service.request.clear_header("InoutListener")
  for name in pairs(kong.request.get_headers()) do
    local lower = string.lower(name)
    -- The step-up proof is minted by the app BFF and cryptographically bound
    -- to its bearer token; the API validates it before allowing user admin.
    -- Preserve only that X-InOut header while stripping caller-supplied ones.
    if lower:find("^x%-client%-") or
       (lower:find("^x%-inout%-") and lower ~= "x-inout-step-up") or
       lower == "x-proxy-secret" then
      kong.service.request.clear_header(name)
    end
  end
  -- Explicitly remove trusted headers even if the input header list was capped.
  for _, name in ipairs({ "X-Inout-Terminal-DN", "X-Inout-Gateway-Secret", "X-Client-Verify", "X-Client-DN", "X-Proxy-Secret" }) do
    kong.service.request.clear_header(name)
  end

  local path = kong.request.get_path()
  if path ~= "/v1/scans" and path ~= "/v1/scans/" then return end
  if ngx.var.server_port ~= "8443" or ngx.var.ssl_client_verify ~= "SUCCESS" then
    return kong.response.exit(401, { message = "A verified terminal client certificate is required" })
  end
  local secret = os.getenv("INOUT_TERMINAL_SECRET")
  local dn = ngx.var.ssl_client_s_dn
  if not secret or #secret < 32 or not dn or dn == "" then
    return kong.response.exit(503, { message = "Terminal certificate authentication is not configured" })
  end
  kong.service.request.set_header("X-Inout-Terminal-DN", dn)
  kong.service.request.set_header("X-Inout-Gateway-Secret", secret)
end

return Handler
