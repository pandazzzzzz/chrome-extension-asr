/**
 * Redact common credential shapes from diagnostic text.
 *
 * This is intentionally a small, dependency-free helper so the diagnostic
 * page can load it as an external script and the Node tests can exercise the
 * exact same implementation.
 */
globalThis.redactDebugText = function redactDebugText(value) {
  let text = String(value ?? '');
  const credentialHostLabel = /^(?:sk|pk|api[_-]?key|access[_-]?token|token|secret|credential)[-_]/i;

  function redactAuthority(authority) {
    const at = authority.lastIndexOf('@');
    const prefix = at === -1 ? '' : authority.slice(0, at + 1);
    const hostPort = authority.slice(at + 1);
    if (hostPort.startsWith('[')) return prefix + hostPort;
    const colon = hostPort.lastIndexOf(':');
    const hasPort = colon !== -1 && /^\d+$/.test(hostPort.slice(colon + 1));
    const host = hasPort ? hostPort.slice(0, colon) : hostPort;
    const port = hasPort ? hostPort.slice(colon) : '';
    const redacted = host
      .split('.')
      .map((label) => (credentialHostLabel.test(label) ? '<redacted>' : label))
      .join('.');
    return prefix + redacted + port;
  }

  // Diagnostic URLs never need their fragment. Treat the whole fragment as
  // opaque because OAuth/session tokens are often placed there without a
  // recognizable parameter name.
  text = text.replace(/(#)([^\s"'#]+)/g, '$1<redacted>');

  // URL userinfo: wss://user:password@host/... — keep scheme/host, drop credentials.
  text = text.replace(/\b(https?|wss?):\/\/[^/\s@]+@/gi, '$1://<redacted>@');

  // Credential-shaped hostname labels: wss://sk-secret.proxy.example/...
  text = text.replace(
    /\b(https?|wss?):\/\/([^/\s"'?#]+)/gi,
    (match, scheme, authority) => `${scheme}://${redactAuthority(authority)}`,
  );

  // Redact unknown URL query values, including provider-specific or user-chosen
  // parameter names that the secret-name allowlist cannot know in advance. Keep
  // a few non-sensitive routing/format parameters useful for diagnostics.
  text = text.replace(
    /([?&])(?!(?:model|version|v|region|format|sample_rate)=)([^=&\s"'#]+)=([^&\s"'#]*)/gi,
    '$1$2=<redacted>',
  );

  // URL query parameters: API keys, tokens, and common secret field names.
  const secretName = '(?:api[_-]?key|apikey|access[_-]?token|token|key|client[_-]?secret|secret|password|credential|passwd|private[_-]?key)';
  text = text.replace(
    new RegExp(`\\b(${secretName})=([^&\\s"'#]+)`, 'gi'),
    '$1=<redacted>',
  );

  // JSON fields (including apiKey / accessToken camelCase variants).
  text = text.replace(
    /("(?:api[_-]?key|apikey|access[_-]?token|accesstoken|token|key|authorization|cookie|session[_-]?id|client[_-]?secret|secret|password|credential|passwd|private[_-]?key)"\s*:\s*")([^"]*)(")/gi,
    '$1<redacted>$3',
  );

  // Authorization headers and bearer tokens.
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1<redacted>');
  text = text.replace(
    /\b((?:Proxy-)?Authorization\s*:\s*Basic\s+)[^\s"',;]+/gi,
    '$1<redacted>',
  );
  text = text.replace(
    /\b((?:Set-)?Cookie\s*:\s*)[^\r\n"']+/gi,
    '$1<redacted>',
  );

  return text;
};
