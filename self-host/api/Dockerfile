FROM python:3.11-slim

WORKDIR /app

# curl is used by the compose healthcheck against /health.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV DATA_DIR=/data
ENV PORT=8100

EXPOSE 8100
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
