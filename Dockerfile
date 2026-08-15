# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --silent
COPY . .

# Deployment configuration, all optional. Docker exposes build args to RUN as
# environment variables, and vite's loadEnv reads VITE_-prefixed vars straight
# out of process.env — so declaring the ARG is the whole plumbing. There is
# deliberately no `ENV X=$X` line per var: it would be redundant, and it would
# turn an unpassed arg into an empty STRING rather than leaving it absent,
# which is not the same thing. `VITE_BROADCAST_RELAYS` and
# `VITE_CONCORD_AV_SERVERS` fall back with `??` (see src/lib/platform.ts), so
# an empty string reaches them as a real value and yields an empty list.
#
# For the same reason the defaults are NOT restated here. Every one of these
# already defaults in src/lib/platform.ts / src/lib/blossom.ts; a second copy
# in this file is one nothing tests and that drifts silently. Unset ⇒ the
# source default:
#
#   VITE_APP_NAME              "Armada"                       (platform.ts)
#   VITE_APP_RELAYS            relay.ditto.pub, relay.dreamith.to
#   VITE_BROADCAST_RELAYS      relay.primal.net
#   VITE_SEARCH_RELAYS         relay.ditto.pub, relay.dreamith.to
#   VITE_APP_BLOSSOM_SERVERS   blossom.ditto.pub, .dreamith.to, .primal.net
#   VITE_SANDBOX_DOMAIN        "iframe.diy"
#   VITE_DEFAULT_*             true
#   VITE_CONCORD_AV_SERVERS    https://armada.buzz (empty disables Concord voice)
#   VITE_KLIPY_API_KEY         unset ⇒ the keyless GIFverse backend
#   VITE_NOSTR_PUSH_*          both unset ⇒ no web-push path
ARG VITE_APP_NAME
ARG VITE_APP_RELAYS
ARG VITE_BROADCAST_RELAYS
ARG VITE_SEARCH_RELAYS
ARG VITE_APP_BLOSSOM_SERVERS
ARG VITE_CONCORD_AV_SERVERS
ARG VITE_SANDBOX_DOMAIN
ARG VITE_KLIPY_API_KEY
ARG VITE_DEFAULT_NOISE_SUPPRESSION
ARG VITE_DEFAULT_ECHO_CANCELLATION
ARG VITE_DEFAULT_AUTO_GAIN_CONTROL
ARG VITE_NOSTR_PUSH_PUBKEY
ARG VITE_NOSTR_PUSH_RELAYS
RUN npm run build

# Runtime stage
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
