// Module hook for tools/sim_ironfarm.mjs: `@minecraft/server` resolves to tools/mock/server_ironfarm.mjs (a world that can place blocks).
export async function resolve(specifier, context, next) {
  if (specifier === '@minecraft/server') return { url: new URL('./server_ironfarm.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
