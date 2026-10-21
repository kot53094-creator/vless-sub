FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HUB_DATA_DIR=/data

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-hub.txt .
RUN pip install --no-cache-dir -r requirements-hub.txt

# Приложение + уже отлаженные парсеры из scripts/
COPY hub ./hub
COPY scripts ./scripts

# Миграции БД
COPY alembic.ini ./
COPY migrations ./migrations

RUN mkdir -p /data
EXPOSE 8000

# Схема обновляется до старта приложения; повторный запуск безопасен.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn hub.main:app --host 0.0.0.0 --port 8000 --proxy-headers"]
