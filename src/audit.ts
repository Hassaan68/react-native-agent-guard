import {
  CANONICALIZER_VERSION,
  canonicalizeValue,
  computePayloadHash,
} from './canonical';
import type { AuditLogEntry } from './types';

/**
 * 64-zero hex digest used as `prevHash` for the genesis (index 0) audit entry.
 */
export const GENESIS_AUDIT_HASH = '0'.repeat(64);

export interface AuditChainVerificationResult {
  /** `true` if every entry's `prevHash` and `entryHash` match the cryptographic chain from genesis. */
  valid: boolean;
  /** Zero-based index of the first tampered, out-of-order, or broken audit entry when `valid === false`. */
  brokenAtIndex?: number;
  /** Human-readable explanation of why chain verification failed when `valid === false`. */
  reason?: string;
}

/**
 * Compute the deterministic SHA-256 `entryHash` for an `AuditLogEntry` (excluding its own `entryHash` field).
 */
export function computeAuditEntryHash(
  entryWithoutHash: Omit<AuditLogEntry, 'entryHash'>,
): string {
  const clone: Record<string, unknown> = { ...entryWithoutHash };
  delete clone.entryHash;
  return computePayloadHash(canonicalizeValue(clone));
}

/**
 * Verify the cryptographic integrity of an SHA-256 hash-chained `AuditLogEntry` sequence from genesis.
 * Recomputes every `entryHash` and `prevHash` link to detect mutated, deleted, or reordered entries.
 */
export function verifyAuditChain(
  logs: readonly AuditLogEntry[],
): AuditChainVerificationResult {
  let expectedPrevHash = GENESIS_AUDIT_HASH;

  for (let i = 0; i < logs.length; i += 1) {
    const entry = logs[i];
    if (!entry) {
      continue;
    }

    if (entry.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `Broken prevHash link at index ${i}: expected "${expectedPrevHash}", received "${String(entry.prevHash)}".`,
      };
    }

    const recomputedHash = computeAuditEntryHash(entry);
    if (entry.entryHash !== recomputedHash) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `Tampered audit entry at index ${i}: expected entryHash "${recomputedHash}", received "${String(entry.entryHash)}".`,
      };
    }

    expectedPrevHash = entry.entryHash;
  }

  return { valid: true };
}

function escapeCSVCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = typeof value === 'string' ? value : String(value);
  if (
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const CSV_HEADERS = [
  'timestamp',
  'toolName',
  'policy',
  'status',
  'schemaVersion',
  'canonicalizerVersion',
  'payloadHash',
  'prevHash',
  'entryHash',
  'reason',
] as const;

/**
 * Export an array of `AuditLogEntry` items into a compliance-ready `'json'` or RFC 4180 `'csv'` report string.
 */
export function formatAuditLogs(
  logs: readonly AuditLogEntry[],
  format: 'json' | 'csv',
): string {
  if (format === 'csv') {
    const rows: string[] = [CSV_HEADERS.join(',')];
    for (const entry of logs) {
      const cells = [
        entry.timestamp,
        entry.toolName,
        entry.policy ?? '',
        entry.status,
        entry.schemaVersion ?? '',
        entry.canonicalizerVersion ?? CANONICALIZER_VERSION,
        entry.payloadHash ?? '',
        entry.prevHash ?? '',
        entry.entryHash ?? '',
        entry.errorMessage ?? '',
      ].map(escapeCSVCell);
      rows.push(cells.join(','));
    }
    return rows.join('\n');
  }

  const verification = verifyAuditChain(logs);
  const report = {
    exportedAt: new Date().toISOString(),
    canonicalizerVersion: CANONICALIZER_VERSION,
    chainValid: verification.valid,
    ...(verification.brokenAtIndex !== undefined
      ? {
          brokenAtIndex: verification.brokenAtIndex,
          reason: verification.reason,
        }
      : {}),
    totalEntries: logs.length,
    entries: logs,
  };

  return JSON.stringify(
    report,
    (_k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v),
    2,
  );
}
