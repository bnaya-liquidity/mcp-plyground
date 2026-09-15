import { fileURLToPath } from "node:url";
import path from "node:path";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    name: "playground/ignore-patterns",
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/*.tsbuildinfo",
      "**/*.mjs",
      "**/jest.config.ts",
      "**/jest.config.mjs",
      "**/jest.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: "playground/typescript-rules",
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir,
      },
    },
    rules: {
      // Enforce strict type safety — matches the project preference to avoid any / unknown
      "@typescript-eslint/no-explicit-any": "error",
      // Every named function must declare its return type explicitly; inline
      // callbacks / arrow expressions may stay inferred.
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      // Surface deprecated API usage without failing `pnpm run check` — when a
      // warning appears, check whether a package upgrade resolves it (see CLAUDE.md).
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    name: "playground/nestjs-relaxed",
    files: ["packages/nestjs-mcp/**/*.ts"],
    rules: {
      // Decorator-based DI providers are instantiated by Nest, not "used" lexically.
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    // Spec files in packages/nestjs-mcp use tsconfig.spec.json (overrides exclude to include spec + test files)
    name: "playground/nestjs-mcp-spec-project",
    files: ["packages/nestjs-mcp/**/*.spec.ts"],
    languageOptions: {
      parserOptions: {
        project: "packages/nestjs-mcp/tsconfig.spec.json",
        tsconfigRootDir,
      },
    },
  },
  {
    // Spec files under packages/otel-extensions/test/ (e.g. *.integration.spec.ts) are outside
    // tsconfig.json's "src" include; use tsconfig.spec.json (includes test/**/*) instead.
    name: "playground/otel-extensions-spec-project",
    files: ["packages/otel-extensions/test/**/*.spec.ts"],
    languageOptions: {
      parserOptions: {
        project: "packages/otel-extensions/tsconfig.spec.json",
        tsconfigRootDir,
      },
    },
  },
  {
    // Spec files under services/mcp-playground/{src,test} are outside tsconfig.json's
    // build include; use tsconfig.spec.json instead.
    name: "playground/mcp-playground-spec-project",
    files: [
      "services/mcp-playground/**/*.spec.ts",
      "services/mcp-playground/test/**/*.ts",
    ],
    languageOptions: {
      parserOptions: {
        project: "services/mcp-playground/tsconfig.spec.json",
        tsconfigRootDir,
      },
    },
  },
  {
    name: "playground/test-files-relaxed",
    files: [
      "**/__tests__/**/*.ts",
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/test/**/*.e2e-spec.ts",
    ],
    rules: {
      // Test files often use loose assertions (e.g., expect(anyValue).toBe(...))
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  eslintConfigPrettier,
);
