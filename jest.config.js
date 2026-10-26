// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS config file, require() is correct here
const nextJest = require("next/jest");

/** @type {import('jest').Config} */
const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: "./",
});

const config = {
  coverageProvider: "v8",
  // No React/DOM rendering happens in any current test (Tasks 1-3 are pure
  // lib/ logic) — jsdom would add overhead with no benefit. Switch to
  // "jsdom" once a component test is actually written.
  testEnvironment: "node",
};

module.exports = createJestConfig(config);
