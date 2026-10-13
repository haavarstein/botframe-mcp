// Reject or redact alert text that looks like a credential.
// Keep this conservative: a false reject is better than a secret on a wall.

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const OPENSSH_KEY = /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g;
const PGP_KEY = /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g;

export function looksLikeSecret(text) {
  const value = String(text == null ? '' : text);
  if (!value) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(value)) return true;
  if (/-----BEGIN PGP PRIVATE KEY BLOCK-----/.test(value)) return true;
  if (/\bsk-[A-Za-z0-9]/i.test(value)) return true;
  if (/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9]/i.test(value)) return true;
  if (/\bxox[a-zA-Z0-9-]/.test(value)) return true;
  if (/\bAKIA[A-Z0-9]{8,}/.test(value)) return true;
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)) return true;
  if (/(?:password|passwd|secret|api[_-]?key|token)\s*[=:]/i.test(value)) return true;
  if (/\bBearer\s+\S/i.test(value)) return true;
  if (/\b[a-fA-F0-9]{32,}\b/.test(value)) return true;
  if (/\b[A-Za-z0-9+/]{32,}={0,2}\b/.test(value)) return true;
  // base64url with mixed case and a digit, so long slugs still pass.
  if (/(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,}/.test(value)) return true;
  return false;
}

export function redactSecrets(text) {
  let out = String(text == null ? '' : text);
  out = out.replace(PRIVATE_KEY, '[redacted]');
  out = out.replace(OPENSSH_KEY, '[redacted]');
  out = out.replace(PGP_KEY, '[redacted]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]+/gi, '[redacted]');
  out = out.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/gi, '[redacted]');
  out = out.replace(/\bxox[a-zA-Z0-9-]+/g, '[redacted]');
  out = out.replace(/\bAKIA[A-Z0-9]{8,}/g, '[redacted]');
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?/g, '[redacted]');
  out = out.replace(/((?:password|passwd|secret|api[_-]?key|token)\s*[=:])\s*\S+/gi, '$1 [redacted]');
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  out = out.replace(/\b[a-fA-F0-9]{32,}\b/g, '[redacted]');
  out = out.replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, '[redacted]');
  if (looksLikeSecret(out)) return '[redacted]';
  return out;
}
