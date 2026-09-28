// Module hook: `@minecraft/server` resolves to tools/mock/server.mjs (so game/ code runs in Node).
export async function resolve(specifier, context, next) {
  if (specifier === '@minecraft/server') return { url: new URL('./server.mjs', import.meta.url).href, shortCircuit: true };
  if (specifier === '@minecraft/server-gametest') return { url: new URL('./server-gametest.mjs', import.meta.url).href, shortCircuit: true };
  if (specifier === '@minecraft/server-net') return { url: new URL('./server-net.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
