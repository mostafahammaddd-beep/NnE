export async function resolve(specifier, context, next) {
  if (specifier === "@capacitor/core") return { url: new URL("./capacitor-stub.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
