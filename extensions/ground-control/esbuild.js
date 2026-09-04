const esbuild = require('esbuild');
const { version } = require('./package.json');

// Bundling is not an optimisation: the `@ground-control/*` packages live outside this folder and vsce copies only what is beneath it, so an unbundled
// .vsix throws MODULE_NOT_FOUND on activate. `src/uninstall.ts` is separate because `vscode:uninstall` runs outside the host, without `vscode`.
// `hub` is the background process itself, carried in the extension and written to a stable path on disk (R35).
const options = {
  entryPoints: [
    { in: 'src/extension.ts', out: 'extension' },
    { in: 'src/uninstall.ts', out: 'uninstall' },
    { in: '../../apps/hub/src/main.ts', out: 'hub' },
  ],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  define: { __GC_VERSION__: JSON.stringify(version) },
  outdir: 'dist',
  sourcemap: true,
  logLevel: 'info',
};

async function main() {
  if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    return;
  }

  await esbuild.build(options);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
