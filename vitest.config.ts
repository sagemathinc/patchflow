import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // jest's describe/it/expect as globals, as the tests were written
    globals: true,
    // one file at a time, as jest --runInBand did
    fileParallelism: false,
  },
});
