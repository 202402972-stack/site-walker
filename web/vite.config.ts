import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  publicDir: __dirname + "/public",
  build: {
    outDir: __dirname + "/dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: __dirname + "/index.html",
        app: __dirname + "/app.html",
      },
    },
  },
  server: { port: 5173 },
});
