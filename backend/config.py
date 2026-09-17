from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://inout:inout@localhost:1003/inout"
    READ_DATABASE_URL: str = ""

    # Environment — set to "dev" to bypass mTLS check locally
    ENV: str = "production"

    # Redis (Phase 2)
    REDIS_URL: str = "redis://localhost:1004/0"

    # Keycloak — JWKS verification
    KEYCLOAK_ISSUER: str = "http://localhost:1005/realms/inout"

    KEYCLOAK_JWKS_BASE: str = ""
    KEYCLOAK_AUDIENCE: str = "inout-frontend"
    KEYCLOAK_JWKS_CACHE_TTL: int = Field(default=300, ge=30)
    MTLS_PROXY_SECRET: str = ""

    # Temporal (Phase 4)
    TEMPORAL_HOST: str = "localhost:1006"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    def model_post_init(self, __context) -> None:
        # If READ_DATABASE_URL is not set, fall back to the primary
        if not self.READ_DATABASE_URL:
            object.__setattr__(self, "READ_DATABASE_URL", self.DATABASE_URL)


settings = Settings()
