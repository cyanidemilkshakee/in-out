-- Use Kong's bundled rate-limit engine before authentication or body reads.
-- Service-scoped web and identity instances override the global API instance,
-- selecting separate shared socket-peer budgets. The lower-priority bundled
-- rate-limiting plugin still owns independent verified-account allowances.
local bundled = require "kong.plugins.rate-limiting.handler"
local Handler = { PRIORITY = 20000, VERSION = "1.1.0" }

function Handler:access(conf)
  local port = ngx.var.server_port
  -- The real socket cannot be selected by Host or forwarded listener headers.
  -- Explicit Keycloak maintenance on 8006 stays outside public admission.
  if port ~= "8000" and port ~= "8002" and port ~= "8005" and port ~= "8443" then return end
  return bundled:access(conf)
end

return Handler
