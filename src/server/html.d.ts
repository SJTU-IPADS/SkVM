/**
 * Bun HTML imports: importing an .html file yields an HTMLBundle that
 * Bun.serve's `routes` option serves with its scripts/styles bundled
 * (and embedded under `bun build --compile`).
 */
declare module "*.html" {
  const bundle: import("bun").HTMLBundle
  export default bundle
}
