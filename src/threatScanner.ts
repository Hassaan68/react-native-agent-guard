/**
 * Threat category detected by the input threat scanner middleware.
 */
export type ThreatCategory =
  | 'prompt_injection'
  | 'unsafe_url'
  | 'path_traversal'
  | 'sql_injection'
  | 'command_injection'
  | 'custom';

/**
 * Structured details for a single threat match inside tool arguments.
 */
export interface ThreatDetection {
  /** High-level threat classification. */
  category: ThreatCategory;
  /** Dot/bracket path to the argument field where the threat was found (e.g. `"query"` or `"items[0].url"`). */
  fieldPath: string;
  /** Identifier or pattern name that matched the input. */
  matchedPattern: string;
  /** Truncated excerpt of the offending input string. */
  snippet: string;
  /** Human-readable explanation of the detected threat. */
  message: string;
}

/**
 * Custom rule definition for `ThreatScannerConfig.customRules`.
 */
export interface CustomThreatRule {
  /** Unique rule name. */
  name: string;
  /** Regular expression or predicate function evaluated against string values. */
  pattern: RegExp | ((val: string, path: string) => boolean);
  /** Optional custom warning/error message when the rule matches. */
  message?: string;
}

/**
 * Configuration options for the input threat scanner middleware.
 */
export interface ThreatScannerConfig {
  /** Whether threat scanning is enabled. Defaults to `true` when a `ThreatScannerConfig` object is provided. */
  enabled?: boolean;
  /**
   * When `true` (default), throws a `GuardrailThreatError` immediately upon detecting any threat.
   * When `false`, escalates `'auto'` policy to `'confirm'` (or `escalatePolicy`) and attaches `threats` to `ApprovalRequest` and `AuditLogEntry`.
   */
  blockOnThreat?: boolean;
  /** Policy to escalate to when `blockOnThreat: false` and a threat is detected on an `'auto'` tool. Defaults to `'confirm'`. */
  escalatePolicy?: 'confirm' | 'biometric';
  /** Detect prompt injection and instruction-override payloads. Defaults to `true`. */
  checkPromptInjection?: boolean;
  /** Detect directory traversal (`../`), null bytes, and sensitive system file paths. Defaults to `true`. */
  checkPathTraversal?: boolean;
  /** Detect SQL injection tautologies, `UNION SELECT`, and stacked destructive queries. Defaults to `true`. */
  checkSqlInjection?: boolean;
  /** Detect shell command chaining, subshells (`$(...)`), and backtick execution. Defaults to `true`. */
  checkCommandInjection?: boolean;
  /** Detect `javascript:`/`file:`/`data:text/html` URIs, SSRF metadata/private IPs, and domain allowlist/blocklist violations. Defaults to `true`. */
  checkUnsafeUrls?: boolean;
  /** Optional allowlist of permitted URL hostnames/domains (e.g. `['api.stripe.com', 'example.com']`). */
  allowedDomains?: string[];
  /** Optional blocklist of forbidden URL hostnames/domains. */
  blockedDomains?: string[];
  /** Additional custom regex or predicate rules evaluated on every string argument. */
  customRules?: CustomThreatRule[];
}

export type ThreatScannerOption = boolean | ThreatScannerConfig;

/**
 * Error thrown when `scanArgumentsForThreats` detects one or more security threats
 * and `blockOnThreat` is `true` (the default).
 */
export class GuardrailThreatError extends Error {
  public readonly code = 'THREAT_DETECTED' as const;
  public readonly toolName: string;
  public readonly threats: ThreatDetection[];

  constructor(
    toolName: string,
    threats: ThreatDetection[],
    customMessage?: string,
  ) {
    const details = threats
      .map((t) => `[${t.category}] ${t.fieldPath}: ${t.message}`)
      .join('; ');
    super(
      customMessage ??
        `Input threat scanner blocked execution of tool "${toolName}": ${details}`,
    );
    this.name = 'GuardrailThreatError';
    this.toolName = toolName;
    this.threats = threats;
    Object.setPrototypeOf(this, GuardrailThreatError.prototype);
  }
}

interface PatternRule {
  name: string;
  regex: RegExp;
  message: string;
}

const PROMPT_INJECTION_RULES: PatternRule[] = [
  {
    name: 'ignore_previous_instructions',
    regex:
      /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|above|system)\s+(?:instructions|prompts|rules|directions|guidelines)\b/i,
    message:
      'Detected prompt injection attempt to override prior instructions.',
  },
  {
    name: 'system_prompt_extraction',
    regex:
      /\b(?:reveal|print|show|output|repeat|dump)\s+(?:your\s+|the\s+)?system\s+(?:prompt|instructions|message)\b|\bsystem\s+prompt\s*:/i,
    message:
      'Detected prompt injection attempt to extract or spoof the system prompt.',
  },
  {
    name: 'jailbreak_mode_switch',
    regex:
      /\byou\s+are\s+now\s+(?:in\s+)?(?:developer\s+mode|dan\b|jailbreak|unrestricted\s+mode|god\s+mode)/i,
    message: 'Detected jailbreak / mode-switching prompt injection payload.',
  },
  {
    name: 'special_control_tokens',
    regex:
      /<\|(?:im_start|im_end|system|endoftext|assistant|user)\|>|\[\s*SYSTEM\s*\]|\[\s*INST\s*\]|<<SYS>>/i,
    message: 'Detected LLM chat template control token injection.',
  },
];

const PATH_TRAVERSAL_RULES: PatternRule[] = [
  {
    name: 'dot_dot_slash',
    regex: /(?:^|[\\/])\.\.(?:[\\/]|$)|%2e%2e(?:%2f|%5c|\/|\\)/i,
    message: 'Detected relative path traversal sequence (../).',
  },
  {
    name: 'null_byte_injection',
    regex: /\0|%00/,
    message: 'Detected null-byte injection in path or argument.',
  },
  {
    name: 'sensitive_system_path',
    regex:
      /(?:^|[\s"'=])(?:\/etc\/(?:passwd|shadow|hosts|sudoers)|\/proc\/self\/|c:\\windows\\system32)/i,
    message: 'Detected reference to sensitive operating system file path.',
  },
];

const SQL_INJECTION_RULES: PatternRule[] = [
  {
    name: 'sql_tautology',
    regex:
      /(?:'|")\s*(?:OR|AND)\s+(?:'?\d+'?\s*=\s*'?\d+'?|'[^']+'\s*=\s*'[^']+'|true\b)|'\s*OR\s+1\s*=\s*1/i,
    message: 'Detected SQL injection tautology pattern (e.g. OR 1=1).',
  },
  {
    name: 'sql_union_select',
    regex: /\bUNION\s+(?:ALL\s+)?SELECT\b/i,
    message: 'Detected SQL UNION SELECT injection pattern.',
  },
  {
    name: 'sql_stacked_destructive',
    regex:
      /;\s*(?:DROP|DELETE\s+FROM|TRUNCATE|ALTER)\s+(?:TABLE\s+|DATABASE\s+)?[A-Za-z0-9_`]+/i,
    message: 'Detected stacked destructive SQL statement.',
  },
];

const COMMAND_INJECTION_RULES: PatternRule[] = [
  {
    name: 'subshell_expansion',
    regex: /\$\([^)\r\n]+\)/,
    message: 'Detected shell command substitution $(...).',
  },
  {
    name: 'backtick_execution',
    regex:
      /`\s*(?:whoami|id|cat|curl|wget|bash|sh|zsh|rm|nc|netcat|python|node|perl|env|ls|pwd|chmod|chown)\b[^`]*`/i,
    message: 'Detected backtick shell command execution.',
  },
  {
    name: 'chained_shell_command',
    regex:
      /(?:;|\|\||&&|\|)\s*(?:rm\s+-rf\b|bash\b|sh\b|zsh\b|curl\b|wget\b|nc\b|netcat\b|chmod\b|chown\b|cat\s+\/etc\/|python\s+-c|perl\s+-e)/i,
    message: 'Detected chained shell command injection.',
  },
];

function matchesDomainList(hostname: string, domains: string[]): boolean {
  const lowerHost = hostname.toLowerCase();
  for (const domain of domains) {
    const clean = domain.toLowerCase().trim();
    if (lowerHost === clean || lowerHost.endsWith(`.${clean}`)) {
      return true;
    }
  }
  return false;
}

function isPrivateOrMetadataHost(hostname: string): string | null {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    lower === '169.254.169.254' ||
    lower === 'metadata.google.internal' ||
    lower === '100.100.100.200' ||
    lower === 'fd00:ec2::254'
  ) {
    return `Cloud metadata SSRF target ("${hostname}") is forbidden.`;
  }

  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '0.0.0.0' ||
    lower === '::1'
  ) {
    return `Loopback / localhost URL target ("${hostname}") is forbidden.`;
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) {
      return `Private or link-local IPv4 address ("${hostname}") is forbidden (SSRF protection).`;
    }
  }

  return null;
}

function inspectUrlThreats(
  val: string,
  fieldPath: string,
  config: ThreatScannerConfig,
): ThreatDetection[] {
  const detections: ThreatDetection[] = [];
  const snippet = val.slice(0, 120);

  if (/^\s*(?:javascript|vbscript|file):/i.test(val)) {
    detections.push({
      category: 'unsafe_url',
      fieldPath,
      matchedPattern: 'dangerous_uri_scheme',
      snippet,
      message: 'Dangerous URI scheme (javascript:, vbscript:, or file:) is forbidden.',
    });
    return detections;
  }

  if (/^\s*data:\s*text\/html/i.test(val)) {
    detections.push({
      category: 'unsafe_url',
      fieldPath,
      matchedPattern: 'data_html_uri',
      snippet,
      message: 'Executable data:text/html URI is forbidden.',
    });
    return detections;
  }

  const urlRegex = /https?:\/\/([^\s/:?#"'<>]+)(?::\d+)?(?:[/?#][^\s"'<>]*)?/gi;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(val)) !== null) {
    const hostname = match[1] ?? '';
    if (!hostname) {
      continue;
    }

    if (
      config.blockedDomains &&
      config.blockedDomains.length > 0 &&
      matchesDomainList(hostname, config.blockedDomains)
    ) {
      detections.push({
        category: 'unsafe_url',
        fieldPath,
        matchedPattern: 'blocked_domain',
        snippet,
        message: `URL domain "${hostname}" is explicitly blocked.`,
      });
      continue;
    }

    const isExplicitlyAllowed =
      config.allowedDomains &&
      config.allowedDomains.length > 0 &&
      matchesDomainList(hostname, config.allowedDomains);

    if (
      config.allowedDomains &&
      config.allowedDomains.length > 0 &&
      !isExplicitlyAllowed
    ) {
      detections.push({
        category: 'unsafe_url',
        fieldPath,
        matchedPattern: 'unlisted_domain',
        snippet,
        message: `URL domain "${hostname}" is not in allowedDomains.`,
      });
      continue;
    }

    if (!isExplicitlyAllowed) {
      const ssrfReason = isPrivateOrMetadataHost(hostname);
      if (ssrfReason) {
        detections.push({
          category: 'unsafe_url',
          fieldPath,
          matchedPattern: 'ssrf_private_or_metadata_host',
          snippet,
          message: ssrfReason,
        });
      }
    }
  }

  return detections;
}

/**
 * Normalize a boolean or `ThreatScannerConfig` option into an active `ThreatScannerConfig` or `null` if disabled.
 */
export function resolveThreatScannerConfig(
  globalOption?: ThreatScannerOption,
  toolOption?: ThreatScannerOption,
): ThreatScannerConfig | null {
  const effective = toolOption !== undefined ? toolOption : globalOption;
  if (!effective) {
    return null;
  }
  const baseGlobal =
    typeof globalOption === 'object' && globalOption !== null
      ? globalOption
      : {};
  if (effective === true) {
    return { ...baseGlobal, enabled: true };
  }
  if (effective.enabled === false) {
    return null;
  }
  return {
    ...baseGlobal,
    ...effective,
    enabled: true,
  };
}

/**
 * Recursively inspect all string arguments inside a tool payload for prompt injection,
 * unsafe URLs / SSRF, path traversal, SQL injection, shell command injection, and custom threat rules.
 */
export function scanArgumentsForThreats(
  args: unknown,
  config: ThreatScannerConfig = {},
): ThreatDetection[] {
  if (config.enabled === false) {
    return [];
  }

  const detections: ThreatDetection[] = [];
  const seen = new WeakSet<object>();

  const checkString = (val: string, fieldPath: string) => {
    const snippet = val.slice(0, 120);

    if (config.checkPromptInjection !== false) {
      for (const rule of PROMPT_INJECTION_RULES) {
        if (rule.regex.test(val)) {
          detections.push({
            category: 'prompt_injection',
            fieldPath,
            matchedPattern: rule.name,
            snippet,
            message: rule.message,
          });
        }
      }
    }

    if (config.checkPathTraversal !== false) {
      for (const rule of PATH_TRAVERSAL_RULES) {
        if (rule.regex.test(val)) {
          detections.push({
            category: 'path_traversal',
            fieldPath,
            matchedPattern: rule.name,
            snippet,
            message: rule.message,
          });
        }
      }
    }

    if (config.checkSqlInjection !== false) {
      for (const rule of SQL_INJECTION_RULES) {
        if (rule.regex.test(val)) {
          detections.push({
            category: 'sql_injection',
            fieldPath,
            matchedPattern: rule.name,
            snippet,
            message: rule.message,
          });
        }
      }
    }

    if (config.checkCommandInjection !== false) {
      for (const rule of COMMAND_INJECTION_RULES) {
        if (rule.regex.test(val)) {
          detections.push({
            category: 'command_injection',
            fieldPath,
            matchedPattern: rule.name,
            snippet,
            message: rule.message,
          });
        }
      }
    }

    if (config.checkUnsafeUrls !== false) {
      detections.push(...inspectUrlThreats(val, fieldPath, config));
    }

    if (config.customRules) {
      for (const custom of config.customRules) {
        let matched = false;
        if (custom.pattern instanceof RegExp) {
          if (custom.pattern.global || custom.pattern.sticky) {
            custom.pattern.lastIndex = 0;
          }
          matched = custom.pattern.test(val);
        } else if (typeof custom.pattern === 'function') {
          matched = Boolean(custom.pattern(val, fieldPath));
        }

        if (matched) {
          detections.push({
            category: 'custom',
            fieldPath,
            matchedPattern: custom.name,
            snippet,
            message:
              custom.message ??
              `Custom threat scanner rule "${custom.name}" matched field "${fieldPath}".`,
          });
        }
      }
    }
  };

  const visit = (node: unknown, path: string) => {
    if (node === null || node === undefined) {
      return;
    }

    if (typeof node === 'string') {
      checkString(node, path || '<root>');
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const obj = node as object;
    if (seen.has(obj)) {
      return;
    }
    seen.add(obj);

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i += 1) {
        visit(obj[i], path ? `${path}[${i}]` : `[${i}]`);
      }
      return;
    }

    if (obj instanceof Set) {
      let idx = 0;
      for (const item of obj.values()) {
        visit(item, path ? `${path}[${idx}]` : `[${idx}]`);
        idx += 1;
      }
      return;
    }

    if (obj instanceof Map) {
      for (const [k, v] of obj.entries()) {
        const keyStr = String(k);
        if (typeof k === 'string') {
          checkString(k, path ? `${path}.${keyStr}<key>` : `${keyStr}<key>`);
        }
        visit(v, path ? `${path}.${keyStr}` : keyStr);
      }
      return;
    }

    if (obj instanceof Date || ArrayBuffer.isView(obj)) {
      return;
    }

    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      visit(val, nextPath);
    }
  };

  visit(args, '');
  return detections;
}
