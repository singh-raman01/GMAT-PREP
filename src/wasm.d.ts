// A WebAssembly file imported with { type: "file" }: its path, which a
// compiled executable embeds.
declare module "*.wasm" {
  const path: string
  export default path
}
