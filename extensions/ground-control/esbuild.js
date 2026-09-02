const esbuild = require('esbuild');

// Bundling is not an optimisation: `@ground-control/github` lives outside this folder and vsce copies only what is beneath it, so an unbundled
// .vsix throws MODULE_NOT_FOUND on activate. `src/uninstall.ts` is separate because `vscode:uninstall` runs outside the host, without `vscode`.
const options = {
  entryPoints: ['src/extension.ts', 'src/uninstall.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
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
