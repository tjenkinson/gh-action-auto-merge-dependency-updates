import typescript from 'rollup-plugin-typescript2';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'src/index.ts',
  plugins: [typescript(), resolve(), commonjs()],
  // onwarn: (e) => {
  //   throw e;
  // },
  external: [
    'os',
    'path',
    'fs',
    'url',
    'http',
    'https',
    'tls',
    'util',
    'events' /* TODO import list from same thing resolve() uses */,
  ],
  output: [
    {
      file: 'dist/index.js',
      format: 'cjs',
    },
  ],
};
