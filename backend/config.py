from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://inout:inout@localhost:6432/inout"
    READ_DATABASE_URL: str = ""

    # Environment — set to "dev" to bypass mTLS check locally
    ENV: str = "production"

    # Redis (Phase 2)
    REDIS_URL: str = "redis://localhost:6379/0"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    def model_post_init(self, __context) -> None:
        # If READ_DATABASE_URL is not set, fall back to the primary
        if not self.READ_DATABASE_URL:
            object.__setattr__(self, "READ_DATABASE_URL", self.DATABASE_URL)


settings = Settings()
