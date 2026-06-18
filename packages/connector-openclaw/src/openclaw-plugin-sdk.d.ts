// Ambient declaration for the host-provided peer module. It only needs to make
// the import resolvable; src/plugin.ts casts definePluginEntry against the
// source-cited shim type so the object literal is fully typed. At runtime
// OpenClaw provides the real @openclaw/plugin-sdk. See the vendored OpenClaw source.
declare module "@openclaw/plugin-sdk/plugin-entry" {
  export const definePluginEntry: (options: unknown) => unknown;
}
