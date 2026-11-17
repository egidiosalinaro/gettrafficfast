import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * eslint-config-next 16 ships flat configs. Running them through FlatCompat,
 * which exists to wrap legacy eslintrc configs, made ESLint try to serialise
 * an already-flat config and fail on a circular reference before it linted a
 * single file. Importing them directly is both correct and simpler.
 */
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
