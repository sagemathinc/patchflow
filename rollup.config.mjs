import { builtinModules } from "node:module";
import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "rollup-plugin-typescript2";

const external = (id) =>
  id.startsWith("node:") || builtinModules.includes(id) || id === "immutable";

/** @type {import('rollup').RollupOptions} */
const config = {
  input: [
    "src/index.ts",
    "examples/basic-session.ts",
    "examples/tcp-session.ts",
    "examples/db-immer-session.ts",
  ],
  output: {
    dir: "dist/esm",
    format: "esm",
    sourcemap: true,
    preserveModules: true,
    preserveModulesRoot: "src",
  },
  external,
  plugins: [
    resolve({ extensions: [".ts", ".js"] }),
    commonjs(),
    typescript({
      tsconfig: "./tsconfig.esm.json",
      tsconfigOverride: {
        compilerOptions: {
          declaration: false,
          declarationMap: false,
        },
      },
      useTsconfigDeclarationDir: true,
      clean: true,
    }),
  ],
};

export default config;
