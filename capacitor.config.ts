/// <reference types="@capacitor-community/safe-area" />

import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'buzz.armada.app',
  appName: 'Armada',
  webDir: 'dist',
  // No Capacitor bridge logging, in debug builds too (the default logs there).
  // It writes every plugin call AND its full result to logcat and routes every
  // console message through the native bridge — and ArmadaDB results are
  // whole pages of rumors as JSON text, so a debug build spent its time
  // stringifying payloads into logcat (~290 KB a minute measured on a Pixel)
  // and froze on every sync burst. Web console output is still on
  // chrome://inspect; release builds never logged.
  loggingBehavior: 'none',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    // Match the app's dark theme background (index.html theme-color #100b15).
    backgroundColor: '#100b15',
  },
  ios: {
    // Match the app's dark theme background (index.html theme-color #100b15),
    // so the gap behind the WebView during launch/rubber-band scrolling is the
    // app color rather than white.
    backgroundColor: '#100b15',
    // The WebView owns its own insets: the app pads with
    // env(safe-area-inset-*) (see index.css), so UIKit must not additionally
    // inset the scroll view or the top chrome gets double padding.
    contentInset: 'never',
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
    // Capacitor v8 ships its own (beta) inset handling that conflicts with the
    // safe-area plugin — leaving an extra band/padding at the top. The safe-area
    // plugin docs require disabling it so the plugin owns edge-to-edge insets.
    SystemBars: {
      insetsHandling: 'disable',
    },
    // Soft keyboard handling. `Native` resize lets Android's own
    // windowSoftInputMode="adjustResize" (set in AndroidManifest.xml) shrink the
    // WebView viewport when the keyboard opens, so the in-flow chat composer is
    // pushed up above the keyboard instead of being covered — the single biggest
    // "this is a webpage in a box" giveaway when it's missing. The on-screen
    // accessory bar is suppressed for a cleaner native feel.
    Keyboard: {
      resize: KeyboardResize.Native,
      resizeOnFullScreen: true,
    },
  },
};

export default config;
