// The `export *` barrel over the construction provider — the transform never touches
// this file; the registries alias its keys onto the declaring module's entries and the
// composed configs import the forwarded `<Name>Config` aliases from HERE (§10.26).
export * from "./construction-barrel-provider.js"
