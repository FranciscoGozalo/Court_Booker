# Court alert bot. No packages to install: it runs on Node alone.
FROM node:22-alpine
WORKDIR /app
COPY package.json index.js app.js ./
COPY lib ./lib
ENV NODE_ENV=production
# Runs as root on purpose: Railway mounts volumes as root, and the settings file lives on one.
CMD ["node", "index.js"]
