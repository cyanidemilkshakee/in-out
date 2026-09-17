# syntax=docker/dockerfile:1

# Resolve and install dependencies outside the runtime image.  The lockfile is
# copied before the application source so dependency layers stay cacheable.
FROM python:3.10-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /build

# uv is needed only while building the virtualenv and is never copied to the
# runtime stage.
COPY --from=ghcr.io/astral-sh/uv:0.8.13@sha256:4de5495181a281bc744845b9579acf7b221d6791f99bcc211b9ec13f417c2853 /uv /uvx /bin/
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Copy only the application after dependencies have been resolved.  The
# .dockerignore removes tests, caches, and development-only files.
COPY . .

# Runtime image: contains the interpreter, production virtualenv, and source,
# but no uv, compiler, headers, or dependency resolver cache.
FROM python:3.10-slim AS runtime

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN addgroup --system --gid 10001 app \
    && adduser --system --uid 10001 --ingroup app app

COPY --from=builder --chown=app:app /opt/venv /opt/venv
COPY --from=builder --chown=app:app /build ./

USER app

EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && python seed.py reference && exec uvicorn main:app --host 0.0.0.0 --port 8000"]
