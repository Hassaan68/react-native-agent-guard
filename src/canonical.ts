/**
 * Version identifier for the deterministic RFC 8785 (JCS) + React Native extended canonicalizer.
 * Bound into every canonical envelope (`canonicalizerVersion: 'jcs-rn-v1'`) so backend verifiers
 * and audit receipts know the exact normalization rules used to produce `payloadHash`.
 */
export const CANONICALIZER_VERSION = 'jcs-rn-v1';

/**
 * Error thrown when tool arguments contain non-canonicalizable values
 * such as Functions, Symbols, non-finite numbers (NaN/Infinity), circular references, or invalid Dates.
 */
export class GuardrailCanonicalizationError extends Error {
  public readonly code = 'CANONICALIZATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'GuardrailCanonicalizationError';
    Object.setPrototypeOf(this, GuardrailCanonicalizationError.prototype);
  }
}

/**
 * Error thrown when pre-handler digest re-verification detects a TOCTOU mismatch
 * between the approved/attested payload digest and the pre-execution payload digest.
 */
export class GuardrailTamperError extends Error {
  public readonly code = 'TAMPER_DETECTED' as const;
  public readonly expectedHash?: string;
  public readonly actualHash?: string;

  constructor(
    message = 'TOCTOU integrity check failed: tool arguments or schema version drifted before handler execution',
    details?: { expectedHash?: string; actualHash?: string },
  ) {
    super(message);
    this.name = 'GuardrailTamperError';
    this.expectedHash = details?.expectedHash;
    this.actualHash = details?.actualHash;
    Object.setPrototypeOf(this, GuardrailTamperError.prototype);
  }
}

/**
 * Compare two strings lexicographically by UTF-16 code units (RFC 8785 / JCS standard).
 */
function compareUTF16CodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function normalizeValueInternal(
  val: unknown,
  ancestors: WeakSet<object>,
): unknown {
  if (val === null || val === undefined) {
    return val;
  }

  const valueType = typeof val;

  if (valueType === 'boolean' || valueType === 'string') {
    return val;
  }

  if (valueType === 'number') {
    const num = val as number;
    if (!Number.isFinite(num)) {
      throw new GuardrailCanonicalizationError(
        'Cannot canonicalize non-finite number (NaN or Infinity) in tool arguments.',
      );
    }
    return Object.is(num, -0) ? 0 : num;
  }

  if (valueType === 'bigint') {
    return `${(val as bigint).toString()}n`;
  }

  if (valueType === 'function') {
    throw new GuardrailCanonicalizationError(
      'Cannot canonicalize function values in tool arguments.',
    );
  }

  if (valueType === 'symbol') {
    throw new GuardrailCanonicalizationError(
      'Cannot canonicalize Symbol values in tool arguments.',
    );
  }

  if (typeof val === 'object') {
    const obj = val as object;

    if (obj instanceof Date) {
      if (Number.isNaN(obj.getTime())) {
        throw new GuardrailCanonicalizationError(
          'Cannot canonicalize invalid Date value in tool arguments.',
        );
      }
      return obj.toISOString();
    }

    if (obj instanceof Uint8Array) {
      return `uint8:${bytesToHex(obj)}`;
    }

    if (ancestors.has(obj)) {
      throw new GuardrailCanonicalizationError(
        'Cannot canonicalize circular reference in tool arguments.',
      );
    }

    ancestors.add(obj);
    try {
      if (obj instanceof Set) {
        const normalizedElements = Array.from(obj).map((item) => {
          const normalized = normalizeValueInternal(item, ancestors);
          return normalized === undefined ? null : normalized;
        });
        normalizedElements.sort((a, b) =>
          compareUTF16CodeUnits(JSON.stringify(a), JSON.stringify(b)),
        );
        return normalizedElements;
      }

      if (obj instanceof Map) {
        const normalizedEntries: Array<[unknown, unknown]> = [];
        for (const [k, v] of obj.entries()) {
          const nk = normalizeValueInternal(k, ancestors);
          const nv = normalizeValueInternal(v, ancestors);
          normalizedEntries.push([
            nk === undefined ? null : nk,
            nv === undefined ? null : nv,
          ]);
        }
        normalizedEntries.sort((a, b) => {
          const keyCmp = compareUTF16CodeUnits(
            JSON.stringify(a[0]),
            JSON.stringify(b[0]),
          );
          if (keyCmp !== 0) {
            return keyCmp;
          }
          return compareUTF16CodeUnits(
            JSON.stringify(a[1]),
            JSON.stringify(b[1]),
          );
        });
        return normalizedEntries;
      }

      if (Array.isArray(obj)) {
        return obj.map((item) => {
          const normalized = normalizeValueInternal(item, ancestors);
          return normalized === undefined ? null : normalized;
        });
      }

      const symbolKeys = Object.getOwnPropertySymbols(obj);
      if (symbolKeys.length > 0) {
        throw new GuardrailCanonicalizationError(
          'Cannot canonicalize objects containing Symbol keys in tool arguments.',
        );
      }

      const sortedKeys = Object.keys(obj).sort(compareUTF16CodeUnits);
      const normalizedObj: Record<string, unknown> = {};

      for (const key of sortedKeys) {
        const rawProp = (obj as Record<string, unknown>)[key];
        if (rawProp === undefined) {
          continue;
        }
        const normalizedProp = normalizeValueInternal(rawProp, ancestors);
        if (normalizedProp !== undefined) {
          normalizedObj[key] = normalizedProp;
        }
      }

      return normalizedObj;
    } finally {
      ancestors.delete(obj);
    }
  }

  return val;
}

/**
 * Recursively normalize a value for WYSIWYS parity and RFC 8785 (JCS) deterministic serialization:
 * - Objects: keys sorted lexicographically by UTF-16 code units, `undefined` properties omitted.
 * - `Date`: converted to ISO-8601 UTC string (`val.toISOString()`).
 * - `BigInt`: converted to tagged string (`"${val.toString()}n"`).
 * - `Uint8Array`: converted to tagged lowercase hex string (`"uint8:..."`).
 * - `Set`: converted to array of normalized elements sorted deterministically.
 * - `Map`: converted to array of `[key, value]` tuples sorted deterministically by normalized key.
 * - Functions and Symbols: rejected with `GuardrailCanonicalizationError`.
 */
export function normalizeValue(val: unknown): unknown {
  return normalizeValueInternal(val, new WeakSet<object>());
}

export interface CanonicalEnvelopeParams {
  toolName: string;
  schemaVersion?: string;
  args: unknown;
}

/**
 * Produce a deterministic RFC 8785 (JCS) JSON envelope string binding
 * `{ args, canonicalizerVersion, schemaVersion, toolName }` for WYSIWYS approval
 * and hardware biometric attestation.
 */
export function canonicalizeEnvelope(params: CanonicalEnvelopeParams): string {
  const normalizedArgs = normalizeValue(params.args);
  const envelope = {
    args: normalizedArgs === undefined ? null : normalizedArgs,
    canonicalizerVersion: CANONICALIZER_VERSION,
    schemaVersion: params.schemaVersion ?? '1',
    toolName: params.toolName,
  };
  return JSON.stringify(envelope);
}

/**
 * Encode a UTF-16 JS string into UTF-8 bytes without external dependencies.
 */
function encodeUTF8(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i += 1) {
    let codePoint = str.charCodeAt(i);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = ((codePoint - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i += 1;
      }
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Compute a deterministic lowercase hex SHA-256 digest of a canonical envelope string.
 * Implemented in pure TypeScript/JS so it executes identically and synchronously across
 * React Native (Hermes), Expo Snack Web, and Node/Jest without native crypto dependencies.
 */
export function computePayloadHash(envelopeString: string): string {
  const msg = encodeUTF8(envelopeString);
  const msgLen = msg.length;
  const bitLenHi = Math.floor((msgLen * 8) / 0x100000000);
  const bitLenLo = (msgLen * 8) >>> 0;

  const totalLen = (((msgLen + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(totalLen);
  padded.set(msg);
  padded[msgLen] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, bitLenHi, false);
  view.setUint32(totalLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }

    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const w16 = w[i - 16] ?? 0;
      const w7 = w[i - 7] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w16 + s0 + w7 + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const ki = SHA256_K[i] ?? 0;
      const wi = w[i] ?? 0;
      const temp1 = (h + S1 + ch + ki + wi) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

const DATE_MUTATOR_METHODS = [
  'setTime',
  'setMilliseconds',
  'setUTCMilliseconds',
  'setSeconds',
  'setUTCSeconds',
  'setMinutes',
  'setUTCMinutes',
  'setHours',
  'setUTCHours',
  'setDate',
  'setUTCDate',
  'setMonth',
  'setUTCMonth',
  'setFullYear',
  'setUTCFullYear',
  'setYear',
] as const;

function lockMutatorMethods(
  target: object,
  methods: readonly string[],
  typeName: string,
): void {
  const throwFrozen = () => {
    throw new TypeError(`Cannot mutate a deep-frozen ${typeName} instance.`);
  };
  for (const method of methods) {
    try {
      Object.defineProperty(target, method, {
        value: throwFrozen,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      // Ignore if already non-configurable
    }
  }
}

function deepFreezeInternal<T>(obj: T, seen: WeakSet<object>): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  const target = obj as unknown as object;
  if (seen.has(target)) {
    return obj;
  }
  seen.add(target);

  if (target instanceof Date) {
    lockMutatorMethods(target, DATE_MUTATOR_METHODS, 'Date');
    return Object.freeze(obj);
  }

  if (target instanceof Map) {
    for (const [k, v] of target.entries()) {
      deepFreezeInternal(k, seen);
      deepFreezeInternal(v, seen);
    }
    lockMutatorMethods(target, ['set', 'delete', 'clear'], 'Map');
    return Object.freeze(obj);
  }

  if (target instanceof Set) {
    for (const v of target.values()) {
      deepFreezeInternal(v, seen);
    }
    lockMutatorMethods(target, ['add', 'delete', 'clear'], 'Set');
    return Object.freeze(obj);
  }

  if (ArrayBuffer.isView(target)) {
    lockMutatorMethods(
      target,
      ['set', 'fill', 'copyWithin', 'reverse', 'sort'],
      'TypedArray',
    );
    try {
      Object.freeze(target);
    } catch {
      // V8 disallows Object.freeze on non-empty TypedArray views; mutator methods are locked
    }
    return obj;
  }

  Object.freeze(target);

  const propNames = Object.getOwnPropertyNames(target);
  for (const name of propNames) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor && 'value' in descriptor) {
      deepFreezeInternal(descriptor.value, seen);
    }
  }

  return obj;
}

/**
 * Recursively freeze objects, arrays, Dates, Maps, and Sets in-place after Zod validation
 * to prevent Time-of-Check to Time-of-Use (TOCTOU) argument mutation while queued.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  return deepFreezeInternal(obj, new WeakSet<object>());
}
