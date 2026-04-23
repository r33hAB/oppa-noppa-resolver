# Railway-compatible Dockerfile for the Oppa Noppa resolver.
#
# Uses Playwright's official base image which already has Chromium + the
# system libs (libnss, libasound, fonts, etc.) Chromium needs. Bare
# node:20-slim would work but we'd spend 5 minutes rebuilding apt deps
# on every deploy.
FROM mcr.microsoft.com/playwright:v1.50.1-jammy

WORKDIR /app

# Copy manifest first so Docker layer cache hits when only src changes.
COPY package.json ./

# `postinstall` in package.json runs `playwright install chromium`.
# The base image already has the browser, so this is ~instant.
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Railway sets PORT; bind to it explicitly. Default dev port 3000.
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]
