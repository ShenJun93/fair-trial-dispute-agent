export function requireFreshRecoveryAuthentication(authenticated: boolean): void {
  if (!authenticated) throw new Error("Fresh recovery administrator authentication required");
}
