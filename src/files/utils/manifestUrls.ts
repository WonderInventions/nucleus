// The only store keys whose contents embed absolute download URLs, one
// pattern per generator:
//   <slug>/<channel>/win32/<arch>[/<rollout>]/RELEASES        (utils/win32.ts)
//   <slug>/<channel>/darwin/<arch>[/<rollout>]/RELEASES.json  (utils/darwin.ts)
//   <slug>/<channel>/linux/<slug>.repo                        (utils/yum.ts)
// Deliberately precise (not a bare endsWith) so client-supplied file names
// under <slug>/temp/ can never match.
const URL_EMBEDDING_MANIFEST_PATTERNS = [
  /\/win32\/[^/]+\/(?:\d{1,3}\/)?RELEASES$/,
  /\/darwin\/[^/]+\/(?:\d{1,3}\/)?RELEASES\.json$/,
  /\/linux\/[^/]+\.repo$/,
];

export const isUrlEmbeddingManifestKey = (key: string): boolean =>
  URL_EMBEDDING_MANIFEST_PATTERNS.some(pattern => pattern.test(key));

const stripTrailingSlashes = (url: string) => url.replace(/\/+$/, '');

/**
 * Replaces every download URL under fromBaseUrl with the same path under
 * toBaseUrl.  The manifest generators all emit `${baseUrl}/${path}`, so
 * matching on the base plus the joining slash rewrites exactly those URLs
 * without risking bare-prefix matches.
 */
export const rewriteManifestBaseUrl = (data: Buffer, fromBaseUrl: string, toBaseUrl: string): Buffer => {
  const from = stripTrailingSlashes(fromBaseUrl);
  const to = stripTrailingSlashes(toBaseUrl);
  if (!from || from === to) return data;
  return Buffer.from(data.toString('utf8').split(`${from}/`).join(`${to}/`), 'utf8');
};
