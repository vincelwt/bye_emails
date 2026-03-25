FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY config.example.yaml config.yaml

# Run
CMD ["bun", "run", "src/index.ts"]
