/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pages serves from /<repo>/; the workflow sets BASE_PATH. Locally it stays "/".
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: "forks",
  },
});
