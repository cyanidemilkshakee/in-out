from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):
    # Database
    # A deployment must supply its provisioned credential; no usable password
    # is embedded in the fallback used by import-only tooling and unit tests.
    DATABASE_URL: str = "postgresql+asyncpg://inout_app@db:5432/inout"
    READ_DATABASE_URL: str = ""
    DATABASE_STATEMENT_CACHE_SIZE: int = Field(default=100, ge=0, le=1000)
    DATABASE_CONNECT_TIMEOUT_SECONDS: float = Field(default=5, ge=0.1, le=30)
    DATABASE_POOL_TIMEOUT_SECONDS: float = Field(default=5, ge=0.1, le=30)
    DATABASE_STATEMENT_TIMEOUT_MS: int = Field(default=15_000, ge=50, le=120_000)
    DATABASE_LOCK_TIMEOUT_MS: int = Field(default=3_000, ge=50, le=30_000)

    # Redis (Phase 2)
    REDIS_URL: str = "redis://localhost:1004/0"
    QUOTA_REDIS_URL: str = ""
    EVENTS_REDIS_URL: str = ""
    QUOTA_REDIS_MAX_CONNECTIONS: int = Field(default=64, ge=4, le=512)
    EVENTS_REDIS_MAX_CONNECTIONS: int = Field(default=160, ge=4, le=2048)

    # Keycloak — JWKS verification
    KEYCLOAK_ISSUER: str = "http://auth.localhost:1005/realms/inout"

    KEYCLOAK_JWKS_BASE: str = ""
    # Internal Keycloak origin for the Admin REST API. This is only used with
    # the current administrator's validated bearer token.
    KEYCLOAK_ADMIN_BASE: str = ""
    KEYCLOAK_AUDIENCE: str = "inout-frontend"
    KEYCLOAK_JWKS_CACHE_TTL: int = Field(default=300, ge=30)
    # Shared only with the BFF, which signs the selected verification window.
    KEYCLOAK_STEP_UP_SIGNING_SECRET: str = ""
    KONG_TERMINAL_SECRET: str = ""
    KONG_IDENTITY_SECRET: str = ""
    MAX_REQUEST_BODY_BYTES: int = Field(default=262_144, ge=1_024, le=10_485_760)
    MAX_SUBJECT_METADATA_BYTES: int = Field(default=16_384, ge=1_024, le=262_144)
    # Data budgets use verified identities, across reads, tokens and replicas.
    DATA_WINDOW_SECONDS: int = Field(default=60, ge=60, le=60)
    DATA_BYTES_PER_MINUTE: int = Field(default=67_108_864, ge=1024, le=1_073_741_824)
    MAX_DATA_RESPONSE_BYTES: int = Field(default=16_777_216, ge=1024, le=67_108_864)
    DATA_SNAPSHOT_MAX_ROWS: int = Field(default=10_000, ge=100, le=100_000)
    DATA_ANALYTICS_MAX_ROWS: int = Field(default=50_000, ge=100, le=500_000)
    BEHAVIOR_COOLDOWN_SECONDS: int = Field(default=60, ge=10, le=3600)
    BEHAVIOR_FAILURES_PER_MINUTE: int = Field(default=20, ge=5, le=1000)
    BEHAVIOR_UNKNOWN_BARCODES_PER_MINUTE: int = Field(default=30, ge=5, le=1000)
    REQUEST_ADMISSION_CONCURRENCY: int = Field(default=64, ge=1, le=1024)
    REQUEST_BODY_DEADLINE_SECONDS: float = Field(default=30, gt=0, le=120)
    PRESENCE_STREAMS_PER_PRINCIPAL: int = Field(default=3, ge=1, le=20)
    PRESENCE_STREAMS_GLOBAL: int = Field(default=128, ge=1, le=2048)
    PRESENCE_LEASE_SECONDS: int = Field(default=45, ge=30, le=120)
    ALERT_EVALUATION_MAX_SUBJECTS: int = Field(default=5000, ge=1, le=100_000)
    ALERT_EVALUATION_MAX_MOVEMENTS: int = Field(default=50_000, ge=1, le=1_000_000)
    ALERT_EVALUATION_MAX_ALERTS: int = Field(default=50_000, ge=1, le=1_000_000)
    ALERT_EVALUATION_MAX_RULES: int = Field(default=1000, ge=1, le=10_000)

    # Retention is opt-in for audit-sensitive records. Set a positive value
    # only after agreeing a retention policy; zero means keep indefinitely.
    IDEMPOTENCY_RETENTION_DAYS: int = Field(default=30, ge=0)
    AUDIT_RETENTION_DAYS: int = Field(default=0, ge=0)
    ALERT_RETENTION_DAYS: int = Field(default=0, ge=0)
    MOVEMENT_RETENTION_DAYS: int = Field(default=0, ge=0)

    # Temporal (Phase 4)
    TEMPORAL_HOST: str = "temporal:7233"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    def model_post_init(self, __context) -> None:
        if self.DATABASE_LOCK_TIMEOUT_MS > self.DATABASE_STATEMENT_TIMEOUT_MS:
            raise ValueError("DATABASE_LOCK_TIMEOUT_MS must not exceed DATABASE_STATEMENT_TIMEOUT_MS")
        # If READ_DATABASE_URL is not set, fall back to the primary
        if not self.READ_DATABASE_URL:
            object.__setattr__(self, "READ_DATABASE_URL", self.DATABASE_URL)


settings = Settings()
