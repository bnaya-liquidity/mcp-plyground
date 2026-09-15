export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    // See test/nestjs-pino.stub.ts: nestjs-pino (CJS) + @nestjs/common (ESM)
    // form a require(esm) cycle jest-runtime refuses to load. Real Node is fine.
    "^nestjs-pino$": "<rootDir>/test/nestjs-pino.stub.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "<rootDir>/tsconfig.spec.json" }],
  },
  testMatch: ["<rootDir>/src/**/*.spec.ts", "<rootDir>/test/**/*.spec.ts"],
  maxWorkers: 1,
};
