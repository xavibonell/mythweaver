# Build context is the repo root (see docker-compose.yml).
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm install
RUN npm --workspace @mythweaver/web run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npm", "run", "start"]
