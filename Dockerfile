# Keep Playwright image tag in sync with package-lock (npm ls playwright).
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:all && npm prune --omit=dev
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
