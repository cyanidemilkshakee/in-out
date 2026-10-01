-- TLS validation belongs to Kong's TLS listener. Never trust certificate
-- identity supplied by a caller, including callers on the Docker network.
local Handler = { PRIORITY = 10000, VERSION = "1.0.0" }

function Handler:rewrite()
  -- Kong 3.9's HTTP net.dst.port can reflect the Host header's port.
  -- Route using the actual socket instead, overwriting any caller value.
  ngx.req.set_header("InoutListener", ngx.var.server_port)

end

function Handler:access()
  kong.service.request.clear_header("InoutListener")
  for name in pairs(kong.request.get_headers()) do
    local lower = string.lower(name)
    if lower:find("^x%-client%-") or lower:find("^x%-inout%-") or lower == "x-proxy-secret" then
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
