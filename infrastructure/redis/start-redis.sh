#!/bin/sh
set -eu
# Never expand secrets into process arguments or logs. Generate the ACL in tmpfs.
for task_secret in "$REDIS_QUOTA_PASSWORD" "$REDIS_EVENTS_PASSWORD" "$REDIS_GATEWAY_PASSWORD"; do
  case "$task_secret" in *[!A-Za-z0-9_-]*|'') echo 'Redis credentials must be random URL-safe values' >&2; exit 1;; esac
  [ "${#task_secret}" -ge 32 ] || { echo 'Redis credentials must contain at least 32 characters' >&2; exit 1; }
done
umask 077
# Pool authentication/negotiation, health checks, DB selection and redis-py
# metadata only. @connection also grants cross-user CLIENT PAUSE/KILL/UNBLOCK.
task_connection_rules='+auth +hello +ping +select +client|setinfo'
{
  printf 'user default off\n'
  printf 'user inout-quota on >%s ~inout:presence-lease:* ~inout:security-limits:* ~inout:auth:revocation:* -@all %s +eval +evalsha +get +mget +set +incr +incrby +ttl +pttl +expire +time +zremrangebyscore +zcard +zadd +zscore +zrem\n' "$REDIS_QUOTA_PASSWORD" "$task_connection_rules"
  # Kong's synchronous bundled policy needs only its own expiring counters.
  printf 'user inout-gateway on >%s ~ratelimit:* -@all %s +eval +incr +expire +info\n' "$REDIS_GATEWAY_PASSWORD" "$task_connection_rules"
  printf 'user inout-events on >%s &presence:updates -@all %s +publish +subscribe +unsubscribe +pubsub\n' "$REDIS_EVENTS_PASSWORD" "$task_connection_rules"
} > /run/inout-redis/users.acl
exec redis-server --aclfile /run/inout-redis/users.acl --protected-mode yes --save '' --appendonly no
