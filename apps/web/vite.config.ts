import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/v1": { target: process.env.VITE_API_PROXY ?? "http://localhost:3000", changeOrigin: true },
      "/openapi.json": { target: process.env.VITE_API_PROXY ?? "http://localhost:3000", changeOrigin: true },
      "/reference": { target: process.env.VITE_API_PROXY ?? "http://localhost:3000", changeOrigin: true },
      "/health": { target: process.env.VITE_API_PROXY ?? "http://localhost:3000", changeOrigin: true },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
  },
});