/// <reference types="@capacitor-community/safe-area" />

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'pub.armada.app',
  appName: 'Armada',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    // Match the app's dark theme background (index.html theme-color #100b15).
    backgroundColor: '#100b15',
  },
  plugins: {
    // Edge-to-edge + safe-area insets. This plugin makes env(safe-area-inset-*)
    // report correct values on modern Chromium (>=140) and falls back to
    // padding the webview on older buggy webviews. The app's CSS reads
    // var(--safe-area-inset-*, env(safe-area-inset-*, 0px)) (see index.css),
    // so top/bottom chrome clears the status/navigation bars on the APK.
    SafeArea: {
      // Status bar content light (the app is dark-themed by default).
      statusBarStyle: 'DARK',
      navigationBarStyle: 'DARK',
    },
  },
};

export default config;
