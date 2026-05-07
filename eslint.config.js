import js from "@eslint/js";
import node from "eslint-plugin-n";
import perfectionist from "eslint-plugin-perfectionist";
import unicorn from "eslint-plugin-unicorn";
import { defineConfig } from "eslint/config";
import globals from "globals";

const nodeRecommended = node.configs["flat/recommended-module"];
const unicornRecommended = unicorn.configs.recommended;

export default defineConfig([
  // Base JS recommended rules for all .js files
  {
    extends: ["js/recommended"],
    files: ["**/*.js"],
    ignores: ["node_modules/", "dist/"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: {
        ...globals.node,
      },
      sourceType: "module",
    },
    plugins: { js },
    rules: {
      "no-console": "error",
      "no-duplicate-imports": "error",
      "no-undef": "error",
      "no-unreachable": "error",
      "no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
      "no-var": "error",
      "prefer-arrow-callback": "warn",
      "prefer-const": "error",
    },
  },

  // Node.js rules (ESM module style)
  {
    files: ["**/*.js"],
    ignores: ["node_modules/", "dist/"],
    plugins: { n: node },
    rules: {
      ...nodeRecommended.rules,
      "n/no-process-exit": "off",
      "n/no-unpublished-import": "off",
      "n/prefer-node-protocol": "error",
    },
  },

  // Unicorn rules (code quality)
  {
    files: ["**/*.js"],
    ignores: ["node_modules/", "dist/"],
    plugins: { unicorn },
    rules: {
      ...unicornRecommended.rules,
      "unicorn/no-abusive-eslint-disable": "off",
      "unicorn/no-nested-ternary": "off",
      "unicorn/no-process-exit": "off",
    },
  },

  // Perfectionist rules (sorting)
  {
    files: ["**/*.js"],
    ignores: ["node_modules/", "dist/"],
    plugins: { perfectionist },
    rules: {
      "perfectionist/sort-imports": "error",
      "perfectionist/sort-objects": "error"
    },
  },
]);
