export default {
  testEnvironment: "node",
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs" } }],
  },
  testMatch: ["<rootDir>/src/**/*.test.ts"],
};
