import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** The bundled fonts are under the SIL Open Font License 1.1, which travels with every copy: dist/dashboard/licenses/. */
const fontLicenses = (): Plugin => ({
  name: "raw-font-licenses",
  generateBundle() {
    for (const font of ["inter", "jetbrains-mono"])
      this.emitFile({ type: "asset", fileName: `licenses/${font}-OFL.txt`, source: readFileSync(`node_modules/@fontsource-variable/${font}/LICENSE`, "utf8") });
  },
});

export default defineConfig({
  root: "web",
  plugins: [react(), fontLicenses()],
  base: "/",
  // Fonts stay files: the dashboard's CSP allows fonts only from 'self', never data: URIs.
  build: { outDir: "../dist/dashboard", emptyOutDir: true, target: "es2022", assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined) },
});
