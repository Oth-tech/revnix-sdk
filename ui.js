// Subpath entry: require("revnix-react/ui"). Kept at the package root
// so every resolver (Metro, Node, TS "node" moduleResolution) finds it
// without an "exports" map. UI pulls in react/react-native peers — keep it
// out of the core index so pure-JS consumers never load them.
module.exports = require("./dist/ui/index.js");
