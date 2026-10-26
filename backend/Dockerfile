# syntax=docker/dockerfile:1

# Resolve and install dependencies outside the runtime image.  The lockfile is
# copied before the application source so dependency layers stay cacheable.
FROM python:3.13-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /build

# uv is needed only while building the virtualenv and is never copied to the
# runtime stage.
COPY --from=ghcr.io/astral-sh/uv:0.8.13@sha256:4de5495181a281bc744845b9579acf7b221d6791f99bcc211b9ec13f417c2853 /uv /uvx /bin/
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Copy only the application after dependencies have been resolved.  The
# .dockerignore removes tests, caches, and development-only files.
COPY . .
# Production runs with a read-only filesystem. Compile application modules
# once here, so every init job, API and worker avoids parsing the same source.
RUN python -m compileall -q -d /app /build

# Runtime image: contains the interpreter, production virtualenv, and source,
# but no uv, compiler, headers, or dependency resolver cache.
FROM python:3.13-slim AS runtime

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Runtime never installs packages. Remove pip and its bundled fallback wheel,
# whose private dependencies are independent of the audited application lock.
RUN python -m pip uninstall --yes pip \
    && rm -rf /usr/local/lib/python3.13/ensurepip

RUN addgroup --system --gid 10001 app \
    && adduser --system --uid 10001 --ingroup app app

COPY --from=builder --chown=app:app /opt/venv /opt/venv
COPY --from=builder --chown=app:app /build ./

USER app

EXPOSE 1102
CMD ["sh", "-c", "echo \"Starting API on http://localhost:${PUBLIC_PORT:-1102}\" && uvicorn main:app --host 0.0.0.0 --port 1102"]
