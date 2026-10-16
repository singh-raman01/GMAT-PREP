import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

// In development the API runs separately; scripts/dev.ts passes its address.
const apiUrl = process.env["GMAT_PREP_API_URL"] ?? "http://127.0.0.1:4747"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fonts and images stay separate files, so nothing needs data: URLs.
    assetsInlineLimit: 0
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // changeOrigin sends the API its own host name, which it checks.
    proxy: { "/api": { target: apiUrl, changeOrigin: true } }
  }
})
