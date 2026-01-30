# ---------- Build stage ----------
FROM node:20-alpine AS builder
WORKDIR /app

ARG VITE_BACKEND_BASE=http://localhost:8000
ENV VITE_BACKEND_BASE=${VITE_BACKEND_BASE}

COPY uploader/package*.json ./
RUN npm ci

COPY uploader .
RUN npm run build

# ---------- Runtime stage ----------
FROM nginx:stable-alpine AS runtime
COPY uploader/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
