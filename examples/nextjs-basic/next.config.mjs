/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep the heavy, server-only TypeScript-VFS graph toolchain out of the bundle (required at runtime
  // on the Node runtime instead).
  serverExternalPackages: ["@langchain/langgraph-api", "@typescript/vfs"],
  webpack: (config) => {
    // skein's graph loader (@skein-js/config) and @langchain/langgraph-api's parser use dynamic
    // `import()`/`require()` by a computed path, which webpack can't statically analyze and reports as
    // "Critical dependency: the request of a dependency is an expression". It's benign here — those
    // paths run only server-side (and this app's `{ deps }` wiring never calls the graph loader) — so
    // silence just that warning rather than letting it clutter the dev/build output.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { message: /Critical dependency: the request of a dependency is an expression/ },
    ];
    return config;
  },
};

export default nextConfig;
