# Armada CI image for ngit-ci's embedded act runner.
#
# The coordinator maps `ubuntu-latest` to this image via NGIT_CI_ACT_PLATFORMS.
# Everything .ngit/act/workflows otherwise downloads on EVERY run is baked in
# as layers: JDK 21 / Node 22 / Go toolcaches (so the setup-* actions no-op),
# the Android SDK, ruby + fastlane (Google Play publish), the zsp binary
# (Zapstore publish), and warm ~/.gradle / ~/.npm dependency caches for this
# repo (the ~350 MB gradle + ~320 MB npm re-download that made cold act runs
# take 4x the old cache-warm GitLab build).
#
# Build (context = repo root, tracked files only):
#   git archive HEAD android package.json package-lock.json capacitor.config.ts \
#     .ngit/ci-image | tar -x -C /tmp/armada-ci-context
#   cp .ngit/ci-image/Dockerfile /tmp/armada-ci-context/Dockerfile
#   docker build -t armada-ci:latest /tmp/armada-ci-context
#
# Rebuild whenever package-lock.json, android/gradle deps, or the tool pins
# below change. The workflows still pin the same versions, so a stale image
# self-heals: setup-* actions download whatever the toolcache lacks.

FROM ghcr.io/catthehacker/ubuntu:act-latest

SHELL ["/bin/bash", "-c"]

# ── Toolcache entries ────────────────────────────────────────────────────────
# Marker convention (verified on a live act job container):
#   /opt/hostedtoolcache/<tool>/<version>/x64{,.complete}
# setup-node/setup-java/setup-go find these and skip their downloads.
ARG NODE_VERSION=22.23.1
ARG JAVA_DIR=21.0.11-10.0.LTS
ARG JAVA_RELEASE=jdk-21.0.11%2B10
ARG GO_VERSION=1.24.13

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

# sdkmanager (below) and gradle (cache warm, bottom) both shell out to java;
# the toolcache entry alone doesn't put it on PATH. setup-java re-exports the
# same JAVA_HOME at job time, so this stays consistent.
ENV JAVA_HOME="/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/${JAVA_DIR}/x64"
ENV PATH="$JAVA_HOME/bin:$PATH"

RUN set -eux; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -xz -C /tmp; \
    mkdir -p "/opt/hostedtoolcache/go/${GO_VERSION}"; \
    mv /tmp/go "/opt/hostedtoolcache/go/${GO_VERSION}/x64"; \
    touch "/opt/hostedtoolcache/go/${GO_VERSION}/x64.complete"

# ── Android SDK (replaces android-actions/setup-android) ─────────────────────
# Same location setup-android uses ($HOME/.android/sdk), matching the SDK
# levels android/variables.gradle builds against (compileSdk 36).
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

# ── Ruby 3.3 + fastlane (replaces ruby/setup-ruby + gem install) ─────────────
# ruby-builder's toolcache tarball for the base image's Ubuntu 24.04, baked
# into the toolcache so ruby/setup-ruby no-ops (and PATH has it regardless).
# fastlane supply uploads the AAB in release.yml; multi_json is installed
# explicitly because representable (fastlane's Play client) requires it
# without declaring it.
ARG RUBY_VERSION=3.3.9
RUN set -eux; \
    curl -fsSL "https://github.com/ruby/ruby-builder/releases/download/toolcache/ruby-${RUBY_VERSION}-ubuntu-24.04.tar.gz" -o /tmp/ruby.tar.gz; \
    mkdir -p "/opt/hostedtoolcache/Ruby/${RUBY_VERSION}"; \
    tar -xzf /tmp/ruby.tar.gz -C "/opt/hostedtoolcache/Ruby/${RUBY_VERSION}"; \
    test -x "/opt/hostedtoolcache/Ruby/${RUBY_VERSION}/x64/bin/ruby"; \
    touch "/opt/hostedtoolcache/Ruby/${RUBY_VERSION}/x64.complete"; \
    rm /tmp/ruby.tar.gz
ENV PATH="/opt/hostedtoolcache/Ruby/${RUBY_VERSION}/x64/bin:$PATH"
RUN set -eux; \
    gem install fastlane multi_json --no-document; \
    gem cleanup; \
    fastlane --version; \
    # act rebuilds the step PATH and does NOT inherit the image's ENV PATH,
    # so the ruby bindir above is invisible to workflow steps. Symlink the
    # tools into /usr/local/bin, which act's PATH always includes.
    for b in ruby gem bundle bundler fastlane; do \
      ln -sf "/opt/hostedtoolcache/Ruby/${RUBY_VERSION}/x64/bin/$b" "/usr/local/bin/$b"; \
    done

# ── zsp binary (replaces setup-go + go install in the Zapstore step) ─────────
ARG ZSP_VERSION=v0.4.12
RUN set -eux; \
    export PATH="/opt/hostedtoolcache/go/${GO_VERSION}/x64/bin:$PATH"; \
    GOBIN=/usr/local/bin go install "github.com/zapstore/zsp@${ZSP_VERSION}"; \
    rm -rf /root/go /root/.cache/go-build; \
    zsp --version

# ── Warm dependency caches for this repo ─────────────────────────────────────
# Mirrors release.yml's build path (npm ci + cap sync + gradle release build)
# so /root/.npm and /root/.gradle hold every dependency the workflows need.
# --ignore-scripts: the repo's lifecycle scripts may need files outside this
# minimal context; only the cache population matters here. /warm is deleted
# afterwards; the caches stay behind as layers.
COPY package.json package-lock.json capacitor.config.ts /warm/app/
COPY android /warm/app/android
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
    cd /; \
    rm -rf /warm

# Sanity: every baked tool the workflows call directly must be on PATH.
RUN set -eux; \
    node --version; \
    go version || true; \
    ruby --version; \
    fastlane --version; \
    zsp --version; \
    sdkmanager --version
