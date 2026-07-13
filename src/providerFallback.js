export async function withProviderFallback({ primary, fallback, isFallbackEligible, onProviderUsed }) {
  let value;
  let usedProvider;

  try {
    value = await primary();
    usedProvider = "openalex";
  } catch (error) {
    if (!isFallbackEligible(error)) {
      throw error;
    }

    value = await fallback();
    usedProvider = "semantic_scholar";
  }

  // Called outside the try/catch so a throwing onProviderUsed can't get
  // mistaken for a primary failure and trigger a spurious fallback attempt.
  onProviderUsed?.(usedProvider);
  return value;
}
