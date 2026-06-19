import { build, context } from "esbuild";

const isWatch = process.argv.includes("--watch");

const workerConfig = {
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "dist/worker.js",
  sourcemap: true,
  // @paperclipai/plugin-sdk is provided by the host runtime; bundling it would
  // (a) bloat the worker by ~300 KB and (b) risk a duplicate-instance bug if
  // the SDK exposes any module-level state.
  external: ["react", "react-dom", "@paperclipai/plugin-sdk"],
  logLevel: "info",
};

const manifestConfig = {
  entryPoints: ["src/manifest.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "dist/manifest.js",
  sourcemap: true,
  external: ["@paperclipai/plugin-sdk"],
  logLevel: "info",
};

const uiConfig = {
  entryPoints: ["src/ui/index.tsx"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/ui/index.js",
  sourcemap: true,
  jsx: "automatic",
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk",
    "@paperclipai/plugin-sdk/ui",
  ],
  logLevel: "info",
};

if (isWatch) {
  const w = await context(workerConfig);
  const m = await context(manifestConfig);
  const u = await context(uiConfig);
  await Promise.all([w.watch(), m.watch(), u.watch()]);
  console.log("esbuild: watching worker + manifest + ui");
} else {
  await Promise.all([
    build(workerConfig),
    build(manifestConfig),
    build(uiConfig),
  ]);
}
