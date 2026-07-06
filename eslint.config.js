import stylistic from "@stylistic/eslint-plugin"
import tseslint from "@typescript-eslint/eslint-plugin"
import tsParser from "@typescript-eslint/parser"
import alignAssignments from "eslint-plugin-align-assignments"

// Single-package config: parser, plugins, rules, and this repo's own paths.
const base = {
    languageOptions: {
        parser: tsParser,
        parserOptions: {
            ecmaVersion: "latest",
            sourceType: "module"
        }
    },
    plugins: {
        "@stylistic": stylistic,
        "@typescript-eslint": tseslint,
        "align-assignments": alignAssignments
    },
    rules: {
        "max-len": [ "warn", { code: 180 } ],
        "@stylistic/semi": [ "error", "never" ],
        "no-trailing-spaces": "warn",
        "@stylistic/comma-dangle": [ "warn", "never" ],
        "align-assignments/align-assignments": "warn",
        "@stylistic/key-spacing": [ "warn", {
            singleLine: { beforeColon: false, afterColon: true },
            multiLine: {
                beforeColon: true,
                afterColon: true,
                align: "colon"
            }
        } ],
        "@stylistic/member-delimiter-style": [ "warn", {
            multiline: { delimiter: "comma", requireLast: false },
            singleline: { delimiter: "comma", requireLast: false }
        } ],
        "array-bracket-spacing": [ "error", "always" ]
    }
}

export default [
    {
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/tests/fixture-suite/**",
            "**/tests/declaration-fixture-suite/**",
            "**/bench/fixtures/generated/**"
        ]
    },
    {
        ...base,
        files: [
            "src/**/*.{ts,tsx}",
            "tests/**/*.{ts,tsx}",
            "bench/**/*.{ts,tsx}",
            "scripts/**/*.{ts,tsx}"
        ]
    }
]
