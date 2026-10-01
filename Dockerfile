# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --silent
COPY . .

# Deployment configuration, all optional. Docker exposes build args to RUN as
# environment variables, and the build reads the names listed in
# src/build/buildConfig.ts straight out of process.env — so declaring the ARG
# is the whole plumbing. There is deliberately no `ENV X=$X` line per var: it
# would be redundant, and it would turn an unpassed arg into an empty STRING
# rather than leaving it absent, which is not the same thing.
# `BROADCAST_RELAYS` and `CONCORD_AV_SERVERS` fall back with `??` (see
# src/lib/platform.ts), so an empty string reaches them as a real value and
# yields an empty list.
#
# For the same reason the defaults are NOT restated here. Every one of these
# already defaults in src/lib/platform.ts / src/lib/blossom.ts; a second copy
# in this file is one nothing tests and that drifts silently. Unset ⇒ the
# source default:
#
#   APP_NAME              "Armada"                       (platform.ts)
#   APP_RELAYS            relay.ditto.pub, relay.dreamith.to
#   BROADCAST_RELAYS      relay.primal.net
#   SEARCH_RELAYS         relay.ditto.pub, relay.dreamith.to
#   APP_BLOSSOM_SERVERS   blossom.ditto.pub, .dreamith.to, .primal.net
#   SANDBOX_DOMAIN        "iframe.diy"
#   DEFAULT_*             true
#   CONCORD_AV_SERVERS    https://armada.buzz (empty disables Concord voice)
#   KLIPY_API_KEY         unset ⇒ the keyless GIFverse backend
#   NOSTR_PUSH2_*         unset ⇒ the public nostr-push2 service
#
# The same names can instead be set per host at runtime, through `window.ENV`.
ARG APP_NAME
ARG APP_RELAYS
ARG BROADCAST_RELAYS
ARG SEARCH_RELAYS
ARG APP_BLOSSOM_SERVERS
ARG CONCORD_AV_SERVERS
ARG SANDBOX_DOMAIN
ARG KLIPY_API_KEY
ARG DEFAULT_NOISE_SUPPRESSION
ARG DEFAULT_ECHO_CANCELLATION
ARG DEFAULT_AUTO_GAIN_CONTROL
ARG NOSTR_PUSH2_PUBKEY
ARG NOSTR_PUSH2_RELAYS
# Deprecated spellings, still read (with a warning) when the name above is unset.
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
ARG VITE_NOSTR_PUSH2_PUBKEY
ARG VITE_NOSTR_PUSH2_RELAYS
RUN npm run build

# Runtime stage
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
