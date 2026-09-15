export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "<rootDir>/tsconfig.spec.json" }],
  },
  testMatch: ["<rootDir>/src/**/*.spec.ts", "<rootDir>/test/**/*.spec.ts"],
  // QUARANTINED: mcp-logger.module.spec.ts cannot be loaded by jest-runtime.
  // @nestjs/common@12 is ESM-only ("type": "module", no CJS entry) and
  // nestjs-pino@5 is CJS-only, and its own index.js -> InjectPinoLogger.js graph
  // require()s @nestjs/common in a cycle. jest-runtime rejects require(esm) in a
  // cycle; real Node 24 imports the same graph without complaint (verified), so
  // this is a test-runtime limitation, NOT a production defect.
  //
  // The suite fails at IMPORT time, so describe.skip cannot park it — it has to
  // be excluded from file selection.
  //
  // WARNING: while parked, this file is checked by NOTHING. The root tsconfig
  // references tsconfig.build.json, which excludes *.spec.ts, so `typecheck:ts`
  // never saw it; ts-jest was its only check, and this entry removes that too.
  // (Verified: a deliberate type error in it passes `pnpm run typecheck:ts`.)
  // Wiring tsconfig.spec.json into the gate would close the hole but currently
  // fails on pre-existing TS2532 errors in other Nest specs.
  //
  // Re-enable by deleting this entry once nestjs-pino ships an ESM build
  // (tracked upstream: nestjs-pino is CJS-only as of 5.0.0) and confirming the
  // suite passes.
  testPathIgnorePatterns: ["<rootDir>/src/telemetry/mcp-logger.module.spec.ts"],
  maxWorkers: 1,
};
