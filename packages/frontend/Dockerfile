FROM node:22 AS builder

WORKDIR /app


# Copy root package files
COPY package.json package-lock.json ./

# Copy workspace package.json files to ensure npm ci works correctly in monorepo
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/

# Install dependencies (using install instead of ci for potential armv7 compatibility issues)
RUN npm install


COPY packages/frontend/src ./packages/frontend/src
COPY packages/frontend/index.html ./packages/frontend/
COPY packages/frontend/tsconfig.json ./packages/frontend/
COPY packages/frontend/vite.config.ts ./packages/frontend/
COPY packages/frontend/public ./packages/frontend/public/

# Keep the browser bundle independent from deployment secrets. The default is
# an empty value, which makes the frontend use its own origin for API requests.
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build --workspace=@nexus-terminal/frontend


FROM nginx:stable-alpine


RUN rm -rf /usr/share/nginx/html/*


COPY --from=builder /app/packages/frontend/dist /usr/share/nginx/html


COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf


EXPOSE 80


CMD ["nginx", "-g", "daemon off;"]
