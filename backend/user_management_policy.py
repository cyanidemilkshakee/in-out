"""Role boundaries for application-managed identity accounts."""

MANAGED_USER_ROLES = frozenset({"admin", "operator"})


def can_manage_user(is_admin: bool, target_roles: list[str] | set[str]) -> bool:
    roles = set(target_roles)
    return is_admin and bool(roles & MANAGED_USER_ROLES)


def can_update_user_fields(
    is_admin: bool,
    target_roles: list[str] | set[str],
    fields: set[str],
) -> bool:
    return can_manage_user(is_admin, target_roles)

