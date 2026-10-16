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
    proxy: {
      "/api": {
        target: apiUrl,
        // The API checks that requests name its own host.
        changeOrigin: true,
        // The API accepts writes only from its own origin. A page served by
        // Vite has Vite's origin, so its requests are passed on as the API's.
        // Requests from any other origin keep theirs and are refused.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyRequest, request) => {
            if (request.headers.origin === `http://${request.headers.host}`) {
              proxyRequest.setHeader("origin", apiUrl)
            }
          })
        }
      }
    }
  }
})
