const esbuild = require('esbuild');
const { version } = require('./package.json');

// Bundle workspace packages because vsce excludes files outside this directory; otherwise activation fails with MODULE_NOT_FOUND.
// Keep `src/uninstall.ts` separate because `vscode:uninstall` runs outside the host, without `vscode`.
// Bundle the background hub in the extension for copying to a stable path on disk (R35).
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
