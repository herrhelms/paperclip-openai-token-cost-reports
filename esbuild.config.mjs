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
  // @paperclipai/plugin-sdk is bundled into the worker so the plugin works
  // when installed from npm under <prefix>/node_modules/@scope/<name>/ where
  // the SDK is NOT in the resolution chain. The bundle grows ~180 KB but the
  // install is self-contained — verified against `paperclipai plugin install`
  // landing the package in /Users/seb/.paperclip/plugins/node_modules/.
  external: ["react", "react-dom"],
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
  // Manifest is tiny and only imports the SDK for its TypeScript types;
  // bundling keeps the install resolution-chain independent like the worker.
  external: [],
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
