# Armada CI image for ngit-ci's embedded act runner.
#
# The coordinator maps `ubuntu-latest` to this image via NGIT_CI_ACT_PLATFORMS.
# Everything .ngit/act/workflows otherwise downloads on EVERY run is baked in
# as layers: JDK 21 / Node 22 / Go toolcaches (so setup-* actions no-op), the
# Android SDK, system ruby + fastlane (Google Play publish), the zsp binary
# (Zapstore publish), wine (Windows electron-builder targets), Flatpak tooling,
# and warm
# ~/.gradle / ~/.npm / ~/.cache/electron{,-builder} dependency caches for this
# repo.
#
# ── IMPORTANT: act mounts a persistent volume OVER /opt/hostedtoolcache ──────
# act mounts the named docker volume `act-toolcache` at /opt/hostedtoolcache in
# every job container. The volume is seeded from the image ONLY when it is
# empty (docker's copy-on-first-mount), then persists forever — so toolcache
# content added in a NEW image build is invisible to jobs until the operator
# removes the stale volume (build.sh does this). This is exactly how the
# Google Play publish broke twice: the image gained ruby+fastlane under
# /opt/hostedtoolcache, but jobs still saw the old volume and the
# /usr/local/bin/fastlane symlink dangled ("fastlane: command not found").
# Rules that follow from this:
#   - ONLY things the setup-* actions look up (node, java, go) belong under
#     /opt/hostedtoolcache. They self-heal anyway: if the volume is stale,
#     setup-node/setup-java download into it once and it stays warm.
#   - Every tool a workflow invokes directly (fastlane, zsp, wine, sdkmanager)
#     must live OUTSIDE /opt/hostedtoolcache, on a path act always includes
#     (/usr/local/bin, /usr/bin) or reachable via env the workflow sets.
#
# Build + push with .ngit/ci-image/build.sh (run on the coordinator host).
# Rebuild whenever package-lock.json, electron/package-lock.json, android/
# gradle deps, or the tool pins below change. The workflows still pin the same
# versions, so a stale image self-heals where a setup-* action exists.

FROM golang:1.24 AS zsp-builder
ARG ZSP_VERSION=v0.4.12
RUN GOBIN=/out go install "github.com/zapstore/zsp@${ZSP_VERSION}"

FROM ghcr.io/catthehacker/ubuntu:act-latest

SHELL ["/bin/bash", "-c"]

# ── Toolcache entries (node, java, go — setup-* action managed) ─────────────
# Marker convention (verified on a live act job container):
#   /opt/hostedtoolcache/<tool>/<version>/x64{,.complete}
# These layers only matter as the SEED for the act-toolcache volume (see the
# header note); at job time the volume shadows this path.
ARG NODE_VERSION=22.23.1
ARG JAVA_DIR=21.0.11-10.0.LTS
ARG JAVA_RELEASE=jdk-21.0.11%2B10
ARG GO_VERSION=1.26.4

RUN set -eux; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /tmp; \
    mkdir -p "/opt/hostedtoolcache/node/${NODE_VERSION}"; \
    mv "/tmp/node-v${NODE_VERSION}-linux-x64" "/opt/hostedtoolcache/node/${NODE_VERSION}/x64"; \
    touch "/opt/hostedtoolcache/node/${NODE_VERSION}/x64.complete"

RUN set -eux; \
    curl -fsSL "https://api.adoptium.net/v3/binary/version/${JAVA_RELEASE}/linux/x64/jdk/hotspot/normal/eclipse" -o /tmp/jdk.tar.gz; \
    mkdir -p "/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/${JAVA_DIR}"; \
    tar -xzf /tmp/jdk.tar.gz -C /tmp; \
    mv /tmp/jdk-21* "/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/${JAVA_DIR}/x64"; \
    touch "/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/${JAVA_DIR}/x64.complete"; \
    rm /tmp/jdk.tar.gz

RUN set -eux; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz; \
    mkdir -p "/opt/hostedtoolcache/go/${GO_VERSION}"; \
    tar -xzf /tmp/go.tar.gz -C /tmp; \
    mv /tmp/go "/opt/hostedtoolcache/go/${GO_VERSION}/x64"; \
    touch "/opt/hostedtoolcache/go/${GO_VERSION}/x64.complete"; \
    rm /tmp/go.tar.gz

# sdkmanager (below) and gradle (cache warm, bottom) both shell out to java;
# the toolcache entry alone doesn't put it on PATH. setup-java re-exports the
# same JAVA_HOME at job time, so this stays consistent.
ENV JAVA_HOME="/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/${JAVA_DIR}/x64"
ENV PATH="/opt/hostedtoolcache/go/${GO_VERSION}/x64/bin:$JAVA_HOME/bin:$PATH"

# ── Android SDK (replaces android-actions/setup-android) ─────────────────────
# Same location setup-android uses ($HOME/.android/sdk), matching the SDK
# levels android/variables.gradle builds against (compileSdk 36). NOT under
# /opt/hostedtoolcache, so the act-toolcache volume can't shadow it.
ENV ANDROID_HOME=/root/.android/sdk \
    ANDROID_SDK_ROOT=/root/.android/sdk
RUN set -eux; \
    mkdir -p "$ANDROID_HOME/cmdline-tools"; \
    curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/cmdline-tools.zip; \
    unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools"; \
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"; \
    rm /tmp/cmdline-tools.zip; \
    export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"; \
    printf 'y\ny\ny\ny\ny\ny\ny\n' | sdkmanager --licenses >/dev/null 2>&1 || true; \
    sdkmanager --install "platforms;android-36" "build-tools;36.0.0" "platform-tools" >/dev/null
ENV PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# ── System ruby + fastlane (Google Play publish in release.yml) ──────────────
# Deliberately the DISTRO ruby, not a /opt/hostedtoolcache toolcache entry:
# setup-ruby's prebuilt rubies are not relocatable AND anything under
# /opt/hostedtoolcache is shadowed by the act-toolcache volume at job time
# (which is how "fastlane: command not found" happened — see header). gem puts
# the binstubs in /usr/local/bin, which act's step PATH always includes.
# multi_json is installed explicitly because representable (fastlane's Play
# client) requires it without declaring it.
RUN set -eux; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ruby-full ruby-dev; \
    rm -rf /var/lib/apt/lists/*; \
    gem install fastlane multi_json --no-document; \
    gem cleanup; \
    fastlane --version; \
    command -v fastlane | grep -qv hostedtoolcache

# ── wine (electron-builder Windows targets in release.yml) ───────────────────
# Cross-building the NSIS installer + portable exe on Linux needs wine; baking
# it here removes the per-run `apt-get install wine` (~1-2 min + network).
RUN set -eux; \
    dpkg --add-architecture i386; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends wine wine32 wine64 || \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends wine; \
    rm -rf /var/lib/apt/lists/*; \
    wine --version

# ── Flatpak (desktop Flatpak target + Electron BaseApp) ─────────────────────
# The SDK/runtime download is much larger than the manifest build itself, so
# keep it in the image rather than repeating it on every version tag. The
# desktop workflow retains a fallback install for stock act images.
RUN set -eux; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends flatpak flatpak-builder; \
    rm -rf /var/lib/apt/lists/*; \
    flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo; \
    flatpak install -y flathub \
      org.freedesktop.Platform//25.08 \
      org.freedesktop.Sdk//25.08 \
      org.electronjs.Electron2.BaseApp//25.08

# ── zsp binary (Zapstore publish; built in the zsp-builder stage) ────────────
COPY --from=zsp-builder /out/zsp /usr/local/bin/zsp
RUN zsp --version

# ── Swift toolchain (ios/ArmadaDB conformance suite in test.yml) ─────────────
# The iOS store's engine is a SwiftPM package precisely so its suite runs on
# Linux — act has no macOS runner and never will, so this is the ONLY place
# iOS storage gets tested at all. Installed under /usr/local/swift with
# binstubs in /usr/local/bin: outside /opt/hostedtoolcache, which the
# act-toolcache volume shadows at job time (see the header), and there is no
# setup-swift in the workflow to self-heal a stale image.
#
# The platform slug has to match the base image's Ubuntu release, so it is read
# from /etc/os-release rather than pinned alongside the version.
ARG SWIFT_VERSION=6.3.3
RUN set -eux; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      binutils libcurl4-openssl-dev libedit2 libpython3-dev libsqlite3-0 \
      libxml2-dev libz3-dev pkg-config tzdata zlib1g-dev; \
    rm -rf /var/lib/apt/lists/*; \
    . /etc/os-release; \
    slug="ubuntu${VERSION_ID//./}"; \
    curl -fsSL "https://download.swift.org/swift-${SWIFT_VERSION}-release/${slug}/swift-${SWIFT_VERSION}-RELEASE/swift-${SWIFT_VERSION}-RELEASE-ubuntu${VERSION_ID}.tar.gz" \
      -o /tmp/swift.tar.gz; \
    mkdir -p /usr/local/swift; \
    tar -xzf /tmp/swift.tar.gz -C /usr/local/swift --strip-components=1; \
    rm /tmp/swift.tar.gz; \
    ln -sf /usr/local/swift/usr/bin/swift /usr/local/bin/swift; \
    ln -sf /usr/local/swift/usr/bin/swiftc /usr/local/bin/swiftc; \
    swift --version; \
    command -v swift | grep -qv hostedtoolcache

# ── Rust wasm toolchain (Mini App realtime transport: crates/webxdc-rt) ──────
# The transport (iroh-gossip compiled to wasm) is built by
# scripts/build-wasm.mjs, which deploy-nsite/desktop/release invoke with
# WEBXDC_RT_REQUIRED=1 — turning a missing toolchain into a failed deploy
# rather than a build that silently ships multiplayer off. Baked here so those
# workflows stop installing it per-run, and (with the warm section below) the
# large iroh dependency tree is fetched once instead of on every version tag.
#
# rustup/cargo live in /root/.cargo, the toolchain + wasm32 std in /root/.rustup
# — all OUTSIDE /opt/hostedtoolcache, so the act-toolcache volume can't shadow
# them (same reasoning as the Android SDK and Swift). The cargo/rustc shims and
# the standalone wasm-pack are linked into /usr/local/bin, which act's step PATH
# always includes; RUSTUP_HOME/CARGO_HOME are exported so the shims resolve the
# toolchain at job time. There is no setup-rust in the workflows, so a stale
# image does NOT self-heal — rebuild when these pins change.
#
# CARGO_TARGET_DIR is a FIXED absolute path so the warm build below and the
# job builds share one target dir: cargo fingerprints registry deps by content
# (path-independent), so iroh's whole tree stays FRESH and is reused rather
# than recompiled per version tag — only the webxdc-rt crate itself, whose
# source the job checks out at a different path, recompiles (cheap).
#
# clang is a hard dependency, not tidiness: iroh's tls-ring feature pulls in
# `ring`, whose build script compiles C/asm and probes for `clang` to target
# wasm32 — with none present it aborts with "failed to find tool clang", which
# is the same failure AGENTS.md warns about on macOS (Apple Clang can't target
# wasm32). The base image ships no clang, so install it here.
ENV RUSTUP_HOME=/root/.rustup \
    CARGO_HOME=/root/.cargo \
    CARGO_TARGET_DIR=/root/.cargo-target
ARG RUST_VERSION=stable
ARG WASM_PACK_VERSION=0.13.1
RUN set -eux; \
    apt-get update -qq; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends clang; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL https://sh.rustup.rs | \
      sh -s -- -y --no-modify-path --profile minimal \
        --default-toolchain "${RUST_VERSION}" \
        --target wasm32-unknown-unknown; \
    ln -sf "$CARGO_HOME/bin/cargo" /usr/local/bin/cargo; \
    ln -sf "$CARGO_HOME/bin/rustc" /usr/local/bin/rustc; \
    ln -sf "$CARGO_HOME/bin/rustup" /usr/local/bin/rustup; \
    curl -fsSL "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 \
          "wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack"; \
    cargo --version; \
    rustc --version; \
    wasm-pack --version; \
    command -v cargo | grep -qv hostedtoolcache; \
    command -v wasm-pack | grep -qv hostedtoolcache

# ── Warm dependency caches for this repo ─────────────────────────────────────
# Mirrors release.yml's android job (npm ci + cap sync + gradle release build)
# and its desktop job (electron npm ci + electron-builder --linux --win) so
# /root/.npm, /root/.gradle (incl. the build cache — android/gradle.properties
# sets org.gradle.caching=true, letting job builds pull unchanged compile task
# outputs FROM-CACHE), and /root/.cache/electron{,-builder} (electron dist
# zips, NSIS, winCodeSign, AppImage tooling) hold everything the workflows
# need. --ignore-scripts: the repo's lifecycle scripts may need files outside
# this minimal context; only the cache population matters here. /warm is
# deleted afterwards; the caches stay behind as layers.
COPY package.json package-lock.json capacitor.config.ts /warm/app/
COPY android /warm/app/android
COPY electron /warm/app/electron
COPY crates /warm/app/crates
RUN set -eux; \
    cd /warm/app; \
    mkdir -p dist; \
    echo '<html><body>cache warm</body></html>' > dist/index.html; \
    cp dist/index.html dist/404.html; \
    npm ci --no-audit --no-fund --ignore-scripts; \
    npx cap sync android; \
    cd android; \
    chmod +x gradlew; \
    # Packaging a release requires a signing config; give the warm-up a
    # throwaway keystore so the FULL task graph (including package/bundle)
    # executes. It never leaves this RUN: /warm is deleted below, and
    # packaging tasks re-run at job time regardless (signing inputs differ).
    keytool -genkeypair -alias upload -keystore app/my-upload-key.keystore \
      -storetype pkcs12 -storepass warmcache -keypass warmcache \
      -keyalg RSA -keysize 2048 -validity 1 -dname CN=cache-warm; \
    printf 'storePassword=warmcache\nkeyPassword=warmcache\nkeyAlias=upload\nstoreFile=my-upload-key.keystore\n' > key.properties; \
    ./gradlew assembleRelease bundleRelease --no-daemon; \
    # Desktop: electron deps + a real electron-builder run for both targets so
    # the electron zip, NSIS, winCodeSign and AppImage tooling downloads land
    # in /root/.cache once, at image build time, not on every release.
    cd /warm/app/electron; \
    mkdir -p dist; \
    cp /warm/app/dist/index.html dist/index.html; \
    # electron/scripts/before-pack.cjs refuses to pack unless db.cjs AND
    # dist/index.html both exist. The real db.cjs comes from `vite build -c
    # vite.config.electron.ts`, which needs src/ — deliberately absent from this
    # warm context. The packaged output is thrown away (only the tool-cache
    # downloads matter), so a stub file satisfies the guard exactly as the stub
    # index.html above does. Without it electron-builder aborts and NOTHING warms.
    printf '// cache-warm stub\n' > db.cjs; \
    npm ci --no-audit --no-fund; \
    ./scripts/build-hevc-publisher.sh --arch x64; \
    npx electron-builder --linux --win --config electron-builder.yml --publish never; \
    # Mini App transport: a REAL release wasm-pack build so iroh's dependency
    # tree is both fetched AND compiled into CARGO_TARGET_DIR once here. Job
    # builds reuse the compiled deps (same target dir, same rustc); the crate's
    # own recompile is all that is left. The wasm output is thrown away — only
    # the registry download and the target-dir cache matter, exactly like the
    # gradle/electron warm builds above.
    cd /warm/app; \
    wasm-pack build --release --target web \
      --out-dir /tmp/warm-wasm crates/webxdc-rt; \
    rm -rf /tmp/warm-wasm; \
    cd /; \
    rm -rf /warm

# Sanity: every baked tool the workflows call directly must be on PATH.
RUN set -eux; \
    node --version; \
    go version; \
    ruby --version; \
    fastlane --version; \
    zsp --version; \
    wine --version; \
    swift --version; \
    flatpak-builder --version; \
    sdkmanager --version; \
    cargo --version; \
    wasm-pack --version
