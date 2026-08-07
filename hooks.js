// Subpath entry: require("revnix-react/hooks"). Kept at the package root
// so every resolver (Metro, Node, TS "node" moduleResolution) finds it
// without an "exports" map. Hooks pull in the react peer — keep them out of
// the core index so pure-JS consumers never load it.
module.exports = require("./dist/hooks/index.js");
