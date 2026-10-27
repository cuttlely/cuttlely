/**
 * Loads an ES module from CommonJS output. The server compiles to CommonJS, so a plain
 * `await import(url)` becomes `require(url)`, which cannot load a file:// URL.
 */
export const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>
