/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Component tests run against the in-browser mock API in demo mode, independent of a local .env.
    env: { VITE_USE_MOCKS: "true", VITE_DEMO_MODE: "true", VITE_API_URL: "http://localhost:4000" },
  },
});
