local typedefs = require "kong.db.schema.typedefs"

return {
  name = "inout-rate-identity",
  fields = {
    { consumer = typedefs.no_consumer },
    { protocols = typedefs.protocols_http },
    { config = {
        type = "record",
        fields = {
          -- Never send the authentication secret/token through a public route
          -- or follow a redirect supplied by an upstream response.
          { identity_url = { type = "string", required = true,
              default = "http://python-api:1102/internal/gateway/identity",
              one_of = { "http://python-api:1102/internal/gateway/identity" } } },
          { cache_ttl = { type = "number", default = 30, between = { 1, 30 } } },
          { timeout_ms = { type = "integer", default = 5000, between = { 100, 15000 } } },
          { connect_timeout_ms = { type = "integer", default = 1000, between = { 100, 5000 } } },
          { max_response_bytes = { type = "integer", default = 4096, between = { 256, 16384 } } },
        },
    } },
  },
}
