import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `ios` holds no JavaScript of its own. What it does hold is a copy of the
  // built web client (`ios/App/App/public`, written by `cap sync` and ignored by
  // `ios/.gitignore` — which a flat config does not read), and SwiftPM `.build`
  // directories that are root-owned when the Swift suites are run through a
  // container. The second makes the walk itself FAIL rather than merely waste
  // time on minified bundles.
  { ignores: ["dist", "node_modules", "coverage", "android", "electron", "ios"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
