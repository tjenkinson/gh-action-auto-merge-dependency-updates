import typescript from 'rollup-plugin-typescript2';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'src/index.ts',
  plugins: [typescript(), resolve(), commonjs()],
  onwarn: (e) => {
    if (!['CIRCULAR_DEPENDENCY', 'UNUSED_EXTERNAL_IMPORT'].includes(e.code)) {
      throw e;
    }
  },
  output: [
    {
      file: 'dist/index.js',
      format: 'cjs',
    },
  ],
};
