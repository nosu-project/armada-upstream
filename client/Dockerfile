# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --silent
COPY . .
ARG VITE_APP_NAME=Armada
ARG VITE_PLATFORM_RELAYS=ws://localhost:5577
ARG VITE_APP_RELAYS=wss://relay.ditto.pub,wss://relay.dreamith.to
ENV VITE_APP_NAME=$VITE_APP_NAME
ENV VITE_PLATFORM_RELAYS=$VITE_PLATFORM_RELAYS
ENV VITE_APP_RELAYS=$VITE_APP_RELAYS
RUN npm run build

# Runtime stage
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
