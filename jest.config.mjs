export default {
  testEnvironment: "node",
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs" } }],
  },
  // L1: source imports carry explicit .js extensions (required for the ESM
  // build); map them back to the .ts sources for ts-jest.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testMatch: ["<rootDir>/src/**/*.test.ts"],
};
