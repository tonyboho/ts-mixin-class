// `prepublishOnly` guard: refuse to publish through anything but pnpm.
//
// `package.json` uses pnpm catalog specifiers (`"typescript": "catalog:"`). Only `pnpm publish`
// (which `changeset publish` runs) rewrites them to real ranges in the tarball; a direct
// `npm publish` ships the literal `catalog:` string, which consumers cannot install — that is
// how 0.0.17 went out broken. The publishing client announces itself in
// `npm_config_user_agent`; anything that is not pnpm is rejected before the tarball is built.

const userAgent = process.env.npm_config_user_agent ?? ""

if (!/^pnpm\//.test(userAgent)) {
    console.error(
        `Refusing to publish through "${userAgent || "an unknown client"}": ` +
        "this package must be published with `pnpm release` (pnpm resolves the `catalog:` " +
        "specifiers in package.json; npm would ship them verbatim). See RELEASING.md."
    )
    process.exit(1)
}
