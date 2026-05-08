import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/workers/index.ts"],
  format: "esm",
  dts: false,
  esbuildOptions(opts) {
    opts.jsx = "automatic";
    opts.jsxImportSource = "satori/jsx";
  },
  onSuccess: "cp -R assets dist/assets",
});
