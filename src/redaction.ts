/**
 * Custom regex pattern rule for PII redaction.
 */
export interface CustomRedactionPattern {
  /** Optional label for the pattern. */
  name?: string;
  /** Regular expression to match sensitive substrings. */
  pattern: RegExp;
  /** Optional custom replacement string for matches of this pattern. */
  replacement?: string;
}

/**
 * Configuration options for automatic PII redaction and argument sanitization.
 */
export interface PIIRedactionConfig {
  /** Whether PII redaction is active. Defaults to `true`. */
  enabled?: boolean;
  /**
   * Custom replacement token used when masking sensitive values.
   * When omitted, type-specific tokens (`[REDACTED_EMAIL]`, `[REDACTED_PHONE]`, `[REDACTED_CARD]`, `[REDACTED_SSN]`, `[REDACTED_TOKEN]`, `[REDACTED]`) are used.
   */
  replacement?: string;
  /**
   * Additional object property names (case-insensitive) whose values should be completely masked.
   * Merged with built-in sensitive keys (`password`, `secret`, `token`, `apiKey`, `ssn`, `cvv`, `pin`, `privateKey`, `authorization`).
   */
  sensitiveKeys?: string[];
  /** Additional custom regex patterns applied to string values. */
  customPatterns?: CustomRedactionPattern[];
  /**
   * When `true`, also passes redacted arguments to the tool's `handler` function.
   * Defaults to `false` (preserves original validated arguments for `handler` while redacting all `onAudit` telemetry and `AuditStorageAdapter` logs).
   */
  redactHandlerInput?: boolean;
}

export type PIIRedactionOption = boolean | PIIRedactionConfig;

const DEFAULT_SENSITIVE_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'apikey',
  'api_key',
  'authorization',
  'ssn',
  'socialsecurity',
  'cvv',
  'cvc',
  'pin',
  'privatekey',
  'private_key',
  'cardnumber',
  'card_number',
];

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
const JWT_REGEX =
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER_REGEX = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const CREDIT_CARD_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;
const PHONE_REGEX =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g;

function normalizeRedactionConfig(
  option?: PIIRedactionOption,
): PIIRedactionConfig | null {
  if (!option) {
    return null;
  }
  if (option === true) {
    return { enabled: true };
  }
  if (option.enabled === false) {
    return null;
  }
  return option;
}

function isSensitiveKeyName(
  key: string,
  extraKeys?: string[],
): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  for (const builtIn of DEFAULT_SENSITIVE_KEYS) {
    if (normalized === builtIn.replace(/[-_\s]/g, '')) {
      return true;
    }
  }
  if (extraKeys) {
    for (const customKey of extraKeys) {
      if (normalized === customKey.toLowerCase().replace(/[-_\s]/g, '')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Redact PII patterns (emails, SSNs, credit cards, phone numbers, JWT/Bearer tokens, and custom regexes)
 * from a string without mutating other content.
 */
export function redactStringPII(
  input: string,
  config: PIIRedactionConfig = {},
): string {
  const mask = (defaultToken: string) => config.replacement ?? defaultToken;

  let result = input;

  // 1. JWTs & Bearer tokens first (before phone/card digit matchers)
  result = result.replace(JWT_REGEX, mask('[REDACTED_TOKEN]'));
  result = result.replace(BEARER_REGEX, mask('[REDACTED_TOKEN]'));

  // 2. Emails
  result = result.replace(EMAIL_REGEX, mask('[REDACTED_EMAIL]'));

  // 3. SSNs (XXX-XX-XXXX)
  result = result.replace(SSN_REGEX, mask('[REDACTED_SSN]'));

  // 4. Credit card numbers (13-19 digits)
  result = result.replace(CREDIT_CARD_REGEX, (match) => {
    const digitsOnly = match.replace(/\D/g, '');
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19) {
      return mask('[REDACTED_CARD]');
    }
    return match;
  });

  // 5. Phone numbers
  result = result.replace(PHONE_REGEX, mask('[REDACTED_PHONE]'));

  // 6. Custom regex patterns
  if (config.customPatterns) {
    for (const rule of config.customPatterns) {
      const flags = rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`;
      const globalRegex = new RegExp(rule.pattern.source, flags);
      result = result.replace(
        globalRegex,
        rule.replacement ?? mask('[REDACTED]'),
      );
    }
  }

  return result;
}

/**
 * Deeply clone and redact PII from any value (strings, arrays, plain objects)
 * without mutating the original input object.
 */
export function redactPIIValue<T = unknown>(
  value: T,
  option: PIIRedactionOption = true,
): T {
  const config = normalizeRedactionConfig(option);
  if (!config) {
    return value;
  }

  const defaultMask = config.replacement ?? '[REDACTED]';

  const visit = (node: unknown): unknown => {
    if (node === null || node === undefined) {
      return node;
    }

    if (typeof node === 'string') {
      return redactStringPII(node, config);
    }

    if (Array.isArray(node)) {
      return node.map((item) => visit(item));
    }

    if (typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(
        node as Record<string, unknown>,
      )) {
        if (
          val !== null &&
          val !== undefined &&
          isSensitiveKeyName(key, config.sensitiveKeys)
        ) {
          out[key] = defaultMask;
        } else {
          out[key] = visit(val);
        }
      }
      return out;
    }

    return node;
  };

  return visit(value) as T;
}
