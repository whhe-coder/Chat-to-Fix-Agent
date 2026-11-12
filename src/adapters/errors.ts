// The error every adapter throws (spec 4, section 2.2): `code`, `message`, `retryable`.
// `retryable` tells the tool wrapper whether a second attempt can help (network, timeout) or not
// (bad argument, missing thing).
export class AdapterError extends Error {
  declare code: string
  declare retryable: boolean
  /**
   * @param {string} code        Short machine-readable reason, for example 'not_found'.
   * @param {string} message     Human-readable reason; never contains a credential.
   * @param {{ retryable?: boolean, cause?: unknown }} [options]
   */
  constructor(code, message, { retryable = false, cause }: { retryable?: boolean, cause?: unknown } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AdapterError'
    this.code = code
    this.retryable = retryable
  }
}

/** Thrown at creation time when a `real` implementation is selected but does not exist yet. */
export function notImplemented(name) {
  return new AdapterError(
    'not_implemented',
    `adapters.${name} is "real": not implemented yet: waiting for the hookup design (use "fake" until then)`,
  )
}

/** Replaces every occurrence of the given secrets in `text` (list every encoded form of a secret too). */
export function redactSecrets(text, secrets = []) {
  let out = String(text)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[redacted]')
  }
  return out
}
