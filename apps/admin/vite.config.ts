import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const apiTarget = process.env.ADMIN_API_TARGET ?? "http://127.0.0.1:18290";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  server: { proxy: { "/api": apiTarget, "/mcp": apiTarget, "/agent": { target: apiTarget, ws: true } } },
});
