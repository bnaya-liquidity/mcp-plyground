import base from "./jest.config.mjs";

export default {
  ...base,
  testMatch: ["<rootDir>/test/**/*.integration.spec.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  testTimeout: 120_000,
};
