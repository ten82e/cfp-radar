/** Required tests must stub discovery HTTP explicitly; live checks belong to CI smoke/discover.yml. */
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`network access is disabled in required tests: ${String(input)}`);
}) as typeof fetch;
