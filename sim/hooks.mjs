// Module hook: `@minecraft/server` resolves to sim/server.mjs (the one engine), the other game modules to empty stand-ins.
export async function resolve(specifier, context, next) {
  if (specifier === '@minecraft/server') return { url: new URL('./server.mjs', import.meta.url).href, shortCircuit: true };
  if (specifier === '@minecraft/server-gametest') return { url: new URL('../tools/mock/server-gametest.mjs', import.meta.url).href, shortCircuit: true };
  if (specifier === '@minecraft/server-net') return { url: new URL('../tools/mock/server-net.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
