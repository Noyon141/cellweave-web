/** Phase 4 verifier startup gate. Build workers never require deployed secrets. */
export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { getServiceTokenVerifier } = await import("./server/authorization/service-token");
    await getServiceTokenVerifier();
  }
}
