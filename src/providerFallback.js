export async function withProviderFallback({ primary, fallback, isFallbackEligible, onProviderUsed }) {
  try {
    const value = await primary();
    onProviderUsed?.("openalex");
    return value;
  } catch (error) {
    if (!isFallbackEligible(error)) {
      throw error;
    }

    const value = await fallback();
    onProviderUsed?.("semantic_scholar");
    return value;
  }
}
