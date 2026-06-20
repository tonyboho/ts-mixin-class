import base from "../../eslint.config.base.js"

// Base settings + this package's own paths.
export default {
    ...base,
    files: [
        "packages/ts-mixin-class/src/**/*.{ts,tsx}",
        "packages/ts-mixin-class/tests/**/*.{ts,tsx}",
        "packages/ts-mixin-class/bench/**/*.{ts,tsx}",
        "packages/ts-mixin-class/scripts/**/*.{ts,tsx}"
    ]
}
