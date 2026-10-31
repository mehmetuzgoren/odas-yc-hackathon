FROM oven/bun:1.4.4-slim AS bun
FROM ghcr.io/astral-sh/uv:0.12.19 AS uv
FROM node:22.23.4-bookworm-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=uv /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run check
ENV UV_PYTHON_INSTALL_DIR=/opt/python
RUN uv python install 3.13.7 && uv sync --frozen --project workers/device --python 3.13.7
ENV NODE_ENV=production DATA_DIR=/data API_HOST=0.0.0.0 API_PORT=3000 DEVICE_PORT=8090 RELAY_PORT=8787
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/api/health");process.exit(r.ok?0:1)'
CMD ["bun", "run", "start"]
