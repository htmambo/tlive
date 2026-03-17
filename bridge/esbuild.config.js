import { build } from 'esbuild';

const isWatch = process.argv.includes('--watch');

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/main.mjs',
  external: [
    '@anthropic-ai/*',
    'discord.js',
    '@larksuiteoapi/*',
    'node-telegram-bot-api',
  ],
  sourcemap: true,
  ...(isWatch ? { watch: true } : {}),
});
