-- Retain the bundled plugin's validation and Redis/vault defaults verbatim.
local schema = require("kong.tools.table").deep_copy(
  require "kong.plugins.rate-limiting.schema")
schema.name = "inout-ingress-limit"
return schema
