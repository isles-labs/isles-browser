/**
 * HTTP request headers in Node.js cannot contain arbitrary Unicode characters.
 * Keep cloud metadata lossless while converting it to an ASCII-only value.
 */
export const encodeCloudHeaderValue = (value: string) => {
  try {
    return encodeURIComponent(value);
  } catch {
    // encodeURIComponent rejects lone UTF-16 surrogates. Replace malformed input
    // rather than letting an optional metadata header prevent cloud requests.
    return encodeURIComponent(value.replace(/[\uD800-\uDFFF]/g, '\uFFFD'));
  }
};
