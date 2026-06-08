import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  minify: false,
  sourcemap: false,
  // Keep runtime deps external — npx/npm installs them from package.json. Bundling CJS deps
  // (commander) into ESM trips esbuild's "Dynamic require" guard.
  shims: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
