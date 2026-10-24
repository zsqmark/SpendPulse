# SpendPulse backend — portable container image.
# Runs `server.ts` via tsx (tsx is in dependencies) and serves both the API and the
# built frontend (dist). Mount a PERSISTENT VOLUME at /app/data so the file-backed
# database (data/database.json) and uploaded page images (data/documents) survive restarts.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The frontend is served by Vercel, so this image deliberately does NOT run `vite build`.
# Skipping it keeps peak build memory low - which matters a lot on small VPS plans where
# `npm ci` / a Vite build can otherwise be OOM-killed (exit 137).
# If you ever want THIS container to serve the UI too, add `RUN npm run build` here.
RUN npm prune --omit=dev    # drop devDeps; tsx stays because it is a dependency

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app .
EXPOSE 3000
# server.ts binds 0.0.0.0 and reads PORT from env (defaults to 3000).
CMD ["npm", "start"]
