/**
 * Redact common credential shapes from diagnostic text.
 *
 * This is intentionally a small, dependency-free helper so the diagnostic
 * page can load it as an external script and the Node tests can exercise the
 * exact same implementation.
 */
globalThis.redactDebugText = function redactDebugText(value) {
  let text = String(value ?? '');

  // URL query parameters: api_key, api-key, apikey, access_token, token, key.
  text = text.replace(
    /\b(api[_-]?key|apikey|access[_-]?token|token|key)=([^&\s"'#]+)/gi,
    '$1=<redacted>',
  );

  // JSON fields (including apiKey / accessToken camelCase variants).
  text = text.replace(
    /("(?:api[_-]?key|apikey|access[_-]?token|accesstoken|token|key|authorization)"\s*:\s*")([^"]*)(")/gi,
    '$1<redacted>$3',
  );

  // Authorization headers and bearer tokens.
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1<redacted>');

  return text;
};
