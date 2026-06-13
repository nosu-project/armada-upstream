# Build stage
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /armada-relay .

# Runtime stage
FROM alpine:3.21
RUN adduser -D -u 10001 relay && mkdir -p /data && chown relay:relay /data
USER relay
WORKDIR /home/relay
COPY --from=build /armada-relay /usr/local/bin/armada-relay
EXPOSE 5577
VOLUME ["/data"]
ENV DATABASE_PATH=/data/db
ENTRYPOINT ["armada-relay"]
