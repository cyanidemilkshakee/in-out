FROM python:3.10-slim

WORKDIR /app

RUN pip install uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen || uv sync
COPY . .

EXPOSE 8000
CMD ["sh", "-c", "uv run alembic upgrade head && uv run python seed.py reference && exec uv run uvicorn main:app --host 0.0.0.0 --port 8000"]
