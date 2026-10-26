"""Role boundaries for application-managed identity accounts."""

MASTER_ADMIN_ROLE = "master-admin"
MANAGED_USER_ROLES = frozenset({"admin", "operator"})
OPERATOR_ACCESS_FIELDS = frozenset({"enabled", "checkpoint_id"})


def can_manage_user(is_master_admin: bool, target_roles: list[str] | set[str]) -> bool:
    roles = set(target_roles)
    if MASTER_ADMIN_ROLE in roles:
        # The application must never be able to demote or alter its own
        # highest-trust bootstrap identities.
        return False
    if is_master_admin:
        return bool(roles & MANAGED_USER_ROLES)
    return roles == {"operator"}


def can_update_user_fields(
    is_master_admin: bool,
    target_roles: list[str] | set[str],
    fields: set[str],
) -> bool:
    if not can_manage_user(is_master_admin, target_roles):
        return False
    if is_master_admin:
        return True
    # An ordinary admin may grant/revoke only an existing operator's access
    # switch and assigned scan checkpoint, never edit identity or credentials.
    return fields <= OPERATOR_ACCESS_FIELDS

