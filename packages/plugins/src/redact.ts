const SECRET_PATTERNS = [
  /(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<=Bearer\s)[A-Za-z0-9._~+/=-]{12,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.?[A-Za-z0-9_-]*/g,
  /(?<=(password|token|secret|apikey|api_key)[=:]\s?)[^\s"']{6,}/gi,
  /(?<=(?:code|code_verifier|client_secret|access_token|refresh_token)=)[^&\s"]{6,}/gi,
];

export function redactSecrets(line: string): string {
  let out = line;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}
