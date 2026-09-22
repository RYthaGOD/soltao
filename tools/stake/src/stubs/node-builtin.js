// Stand-in for Node builtins (http, path) that @layerzerolabs/lz-utilities imports for its CLI and
// filesystem helpers. Nothing on the send or quote path calls them; if something ever does, it
// throws loudly here instead of failing somewhere confusing.
const unavailable = new Proxy({}, { get: (_, key) => { if (key === "__esModule" || key === "then") return undefined; throw new Error(`Node builtin "${String(key)}" is not available in the browser`); } });
export default unavailable;
