# SpendPulse backend — portable container image.
# Runs `server.ts` via tsx (tsx is in dependencies) and serves both the API and the
# built frontend (dist). Mount a PERSISTENT VOLUME at /app/data so the file-backed
# database (data/database.json) and uploaded page images (data/documents) survive restarts.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build || true   # vite build -> dist (harmless if frontend already built elsewhere)
RUN npm prune --omit=dev    # drop devDeps; tsx stays because it is a dependency

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app .
EXPOSE 3000
# server.ts binds 0.0.0.0 and reads PORT from env (defaults to 3000).
CMD ["npm", "start"]
