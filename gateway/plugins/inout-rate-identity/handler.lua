-- Select a stable, authenticated credential before the bundled rate limiter.
-- Backend role, assignment and step-up checks still run on the real request.
local http = require "resty.http"
local sha256 = require "resty.sha256"
local to_hex = require("resty.string").to_hex
local json = require "cjson.safe"

local Handler = { PRIORITY = 9000, VERSION = "1.0.0" }
local INVALID = "inout_identity_invalid"
local UNAVAILABLE = "inout_identity_unavailable"

local function digest(value)
  local hash = sha256:new()
  hash:update(value)
  return to_hex(hash:final())
end

local function authenticate(identity)
  -- Kong 3.9's PDK permits an external credential without a consumer. The
  -- bundled limit_by=credential policy uses this ID, never a client header,
  -- bearer token, application container IP, or a static realm-wide consumer.
  kong.client.authenticate(nil, { id = digest(identity) })
end

local function fetch_identity(httpc, conf, authorization, secret)
  httpc:set_timeouts(conf.connect_timeout_ms, conf.timeout_ms, conf.timeout_ms)
  local ok = httpc:connect({ scheme = "http", host = "python-api", port = 1102 })
  if not ok then return nil, UNAVAILABLE end
  local response = httpc:request({
    method = "POST", path = "/internal/gateway/identity", body = "",
    headers = {
      ["Host"] = "python-api:1102",
      ["Authorization"] = authorization,
      ["X-Inout-Gateway-Secret"] = secret,
      ["Content-Length"] = "0",
    },
  })
  if not response then return nil, UNAVAILABLE end
  if response.status == 401 then return nil, INVALID end
  if response.status ~= 200 then return nil, UNAVAILABLE end
  local length = tonumber(response.headers["Content-Length"])
  if length and length > conf.max_response_bytes then return nil, UNAVAILABLE end
  local chunks, size = {}, 0
  while true do
    local chunk, err = response.body_reader(math.min(4096, conf.max_response_bytes + 1 - size))
    if err then return nil, UNAVAILABLE end
    if not chunk then break end
    size = size + #chunk
    if size > conf.max_response_bytes then return nil, UNAVAILABLE end
    chunks[#chunks + 1] = chunk
  end
  local value = json.decode(table.concat(chunks))
  if type(value) ~= "table" or type(value.identity) ~= "string" or
     #value.identity > 2048 or not value.identity:find("^principal:.+:.+$") or
     value.identity:find("%c") or type(value.expires_at) ~= "number" or
     value.expires_at ~= value.expires_at or value.expires_at == math.huge then
    return nil, UNAVAILABLE
  end
  local ttl = math.min(conf.cache_ttl, value.expires_at - ngx.now())
  if ttl <= 0 then return nil, INVALID end
  return { identity = value.identity, expires_at = value.expires_at,
           verified_until = ngx.now() + ttl }, nil, ttl
end

local function bounded_identity(conf, authorization, secret)
  local httpc = http.new()
  -- A total deadline covers slow response headers/chunked replies as well as
  -- the per-socket timeouts. Read at most max_response_bytes + one byte.
  local reader = ngx.thread.spawn(fetch_identity, httpc, conf, authorization, secret)
  local timer = ngx.thread.spawn(function()
    ngx.sleep(conf.timeout_ms / 1000)
    return nil, UNAVAILABLE
  end)
  local ok, value, err, ttl = ngx.thread.wait(reader, timer)
  ngx.thread.kill(reader)
  ngx.thread.kill(timer)
  httpc:close()
  if not ok then return nil, UNAVAILABLE end
  return value, err, ttl
end

local public_get = {
  ["/"] = true, ["/health/live"] = true, ["/health/ready"] = true,
  ["/docs"] = true, ["/docs/oauth2-redirect"] = true,
  ["/redoc"] = true, ["/openapi.json"] = true,
}

function Handler:access(conf)
  local port = ngx.var.server_port
  if port ~= "8002" and port ~= "8443" then return end

  -- Strip identity hints used by other authentication plugins as well as our
  -- own. Trusted terminal headers were selected by the higher-priority plugin.
  for _, name in ipairs({ "X-Consumer-ID", "X-Consumer-Username", "X-Consumer-Custom-ID",
                          "X-Credential-Identifier", "X-Anonymous-Consumer",
                          "X-Inout-Rate-Identity" }) do
    kong.service.request.clear_header(name)
  end
  if port == "8443" then
    local dn = ngx.var.ssl_client_s_dn
    if ngx.var.ssl_client_verify ~= "SUCCESS" or not dn or dn == "" then
      return kong.response.exit(401, { message = "A verified terminal client certificate is required" })
    end
    return authenticate("terminal:" .. dn)
  end

  local method = kong.request.get_method()
  if method == "OPTIONS" or ((method == "GET" or method == "HEAD") and
                            public_get[kong.request.get_path()]) then return end
  -- Inspect every header: duplicate/late Authorization must never select a
  -- different identity here and in FastAPI's independent token verification.
  local authorization = ngx.req.get_headers(0)["authorization"]
  if type(authorization) ~= "string" or #authorization > 16384 or
     not authorization:match("^[Bb][Ee][Aa][Rr][Ee][Rr] [^%s,]+$") then
    return kong.response.exit(401, { message = "Bearer token required" }, { ["WWW-Authenticate"] = "Bearer" })
  end
  local secret = os.getenv("INOUT_GATEWAY_IDENTITY_SECRET")
  if not secret or #secret < 32 then
    return kong.response.exit(503, { message = "Account authentication is not configured" })
  end
  -- Exact-token positive cache only. Keys never contain credentials and include
  -- the verifier configuration, so a secret change cannot reuse old results.
  local key = "inout-rate-identity:" .. digest(conf.identity_url .. "\0" .. secret .. "\0" .. authorization)
  local value, err, hit_level = kong.cache:get(key, { ttl = conf.cache_ttl, resurrect_ttl = 0 },
                                              bounded_identity, conf, authorization, secret)
  if err or not value then
    if err and err:find(INVALID, 1, true) then
      return kong.response.exit(401, { message = "Invalid bearer token" }, { ["WWW-Authenticate"] = "Bearer" })
    end
    return kong.response.exit(503, { message = "Account authentication is temporarily unavailable" })
  end
  -- Check wall-clock token expiry even on an L1/L2 cache hit.
  if value.expires_at <= ngx.now() then
    kong.cache:invalidate_local(key)
    return kong.response.exit(401, { message = "Bearer token has expired" }, { ["WWW-Authenticate"] = "Bearer" })
  end
  -- The pinned mlcache treats 0 as truthy on its resurrection error path. Also
  -- enforce the absolute verification deadline and reject its stale hit level,
  -- so an upstream outage can never extend this plugin's positive cache.
  if hit_level == 4 or not value.verified_until or value.verified_until <= ngx.now() then
    kong.cache:invalidate_local(key)
    return kong.response.exit(503, { message = "Account authentication is temporarily unavailable" })
  end
  authenticate(value.identity)
end

return Handler
