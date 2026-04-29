import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  tsconfig: 'tsconfig.build.json',
  dts: { tsconfig: 'tsconfig.build.json' },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['@claude-cdk/core'],
  splitting: false,
  treeshake: true,
});
