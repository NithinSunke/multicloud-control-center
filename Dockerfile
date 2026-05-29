# syntax=docker/dockerfile:1

FROM node:22-alpine AS frontend-deps
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci

FROM frontend-deps AS frontend-build
COPY frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine AS frontend-prod
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80

FROM node:22-alpine AS backend-deps
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS backend-prod
ENV NODE_ENV=production
WORKDIR /app/backend
RUN apk add --no-cache unzip opentofu
COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY backend/ ./
EXPOSE 4000
CMD ["node", "server.js"]
