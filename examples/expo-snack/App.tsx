import React, { useEffect, useMemo, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { z } from 'zod';
import {
  createGuardrails,
  AgentApprovalProvider,
  AgentApprovalSheet,
  useApprovalRequest,
  toVercelAITools,
  type ApprovalRequest,
  type AuditTelemetryEvent,
} from 'react-native-agent-guard';

/**
 * Biometric verification helper with a clean Web / Simulator fallback
 * so the Expo Snack runs seamlessly both in the browser and on physical iOS/Android devices via Expo Go.
 */
async function verifyBiometricsWithFallback(
  request: ApprovalRequest,
): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const LocalAuthentication = require('expo-local-authentication') as {
      hasHardwareAsync?: () => Promise<boolean>;
      isEnrolledAsync?: () => Promise<boolean>;
      authenticateAsync?: (opts: {
        promptMessage: string;
        cancelLabel: string;
      }) => Promise<{ success: boolean }>;
    };

    if (
      Platform.OS !== 'web' &&
      LocalAuthentication &&
      typeof LocalAuthentication.authenticateAsync === 'function'
    ) {
      const hasHw =
        typeof LocalAuthentication.hasHardwareAsync === 'function'
          ? await LocalAuthentication.hasHardwareAsync()
          : false;
      const isEnrolled =
        typeof LocalAuthentication.isEnrolledAsync === 'function'
          ? await LocalAuthentication.isEnrolledAsync()
          : false;

      if (hasHw && isEnrolled) {
        const res = await LocalAuthentication.authenticateAsync({
          promptMessage: `Biometric Check: ${request.toolName}`,
          cancelLabel: 'Cancel',
        });
        return Boolean(res?.success);
      }
    }
  } catch {
    // Fall through to web/simulator fallback
  }

  // Web / Unenrolled Simulator fallback for Expo Snack browser preview
  return true;
}

// ---------------------------------------------------------------------------
// 1. Initialize GuardrailRegistry with v0.3.2 Capabilities
// ---------------------------------------------------------------------------
const guardrails = createGuardrails({
  defaultPolicy: 'confirm',
  redactPII: {
    enabled: true,
    sensitiveKeys: ['apiKey', 'sessionToken'],
  },
  onBiometricRequired: verifyBiometricsWithFallback,
})
  // Tool 1: Dynamic Policy Routing (<$50 auto, $50-$199 confirm sheet, $200+ biometric)
  .register('send_payment', {
    description:
      'Send an instant transfer with amount-based dynamic policy routing',
    inputSchema: z.object({
      recipient: z
        .string()
        .min(1)
        .transform((s) => s.trim()),
      amountUSD: z.number().positive(),
      memo: z.string().optional(),
    }),
    policy: ({ amountUSD }) => {
      if (amountUSD < 50) return 'auto';
      if (amountUSD < 200) return 'confirm';
      return 'biometric';
    },
    handler: async ({ recipient, amountUSD, memo }) => ({
      txId: `tx_${Math.floor(100000 + Math.random() * 900000)}`,
      recipient,
      amountUSD,
      memo: memo ?? 'N/A',
      status: 'SETTLED',
    }),
  })
  // Tool 2: Agent Loop Protection & Rate Limiting (auto -> escalates to confirm after 2 calls/min)
  .register('agent_API_poll', {
    description:
      'Poll external market feed (auto-approved up to 2x/min, then escalates to confirm)',
    inputSchema: z.object({
      ticker: z.string().default('NVDA'),
      attempt: z.number().int(),
    }),
    policy: 'auto',
    rateLimit: {
      maxCallsPerMinute: 2,
      maxSessionCalls: 10,
      onLimitExceeded: 'confirm',
    },
    handler: async ({ ticker, attempt }) => ({
      ticker,
      price: 138.45,
      attempt,
    }),
  })
  // Tool 3: Automatic PII Redaction in Audit Telemetry
  .register('sync_customer_kyc', {
    description:
      'Sync customer record (handler gets raw data; onAudit telemetry masks PII)',
    inputSchema: z.object({
      customerNote: z.string(),
      apiKey: z.string(),
    }),
    policy: 'auto',
    handler: async (input) => ({
      synced: true,
      handlerReceivedUnredactedKey: input.apiKey.startsWith('Bearer '),
    }),
  });

/**
 * Child status component using `useApprovalRequest()` directly from `react-native-agent-guard`
 * to display the live FIFO approval queue status.
 */
function PendingQueueStatus() {
  const { currentRequest, queueLength } = useApprovalRequest();

  if (!currentRequest) {
    return null;
  }

  return (
    <View style={styles.queueBanner}>
      <Text style={styles.queueBannerText}>
        ⏳ Awaiting user approval for `{currentRequest.toolName}` ({queueLength}{' '}
        in FIFO queue)
      </Text>
    </View>
  );
}

export default function App() {
  const [auditFeed, setAuditFeed] = useState<AuditTelemetryEvent[]>([]);
  const [lastBanner, setLastBanner] = useState<string>(
    'Tap any scenario below to test v0.3.2 guardrails.',
  );
  const [loopCount, setLoopCount] = useState<number>(0);
  const [showAdapterPreview, setShowAdapterPreview] = useState<boolean>(false);

  useEffect(() => {
    return guardrails.onAudit((event) => {
      setAuditFeed((prev) => [event, ...prev.slice(0, 5)]);
    });
  }, []);

  // 4. Vercel AI SDK & Strict OpenAI Tool Exports
  const adapterPreviewJson = useMemo(() => {
    const vercelTools = toVercelAITools(guardrails, { unwrapData: true });
    const strictOpenAI = guardrails.toOpenAITools({ strict: true });
    return JSON.stringify(
      {
        vercelAISDKToolNames: Object.keys(vercelTools),
        openAIStrictSample: strictOpenAI[0],
      },
      null,
      2,
    );
  }, []);

  const runPaymentScenario = async (amountUSD: number, label: string) => {
    setLastBanner(`Running ${label} ($${amountUSD})...`);
    const res = await guardrails.execute<{ txId: string; amountUSD: number }>(
      'send_payment',
      {
        recipient: 'alice.chen@acme.dev',
        amountUSD,
        memo: `Demo transfer (${label})`,
      },
    );

    if (res.success && res.data) {
      setLastBanner(
        `✅ [${res.policy?.toUpperCase()}] Approved $${res.data.amountUSD} (${res.data.txId}) in ${res.durationMs}ms`,
      );
    } else {
      setLastBanner(`🛑 Blocked (${res.code}): ${res.llmFeedback}`);
    }
  };

  const runLoopSpamScenario = async () => {
    const nextAttempt = loopCount + 1;
    setLoopCount(nextAttempt);
    setLastBanner(`Polling market feed (Call #${nextAttempt} in window)...`);

    const res = await guardrails.execute('agent_API_poll', {
      ticker: 'NVDA',
      attempt: nextAttempt,
    });

    if (res.success) {
      setLastBanner(
        `✅ Call #${nextAttempt} succeeded under '${res.policy}' policy (${res.durationMs}ms)`,
      );
    } else {
      setLastBanner(`🛑 Call #${nextAttempt} blocked (${res.code})`);
    }
  };

  const resetLoopQuota = () => {
    guardrails.resetRateLimits('agent_API_poll');
    setLoopCount(0);
    setLastBanner('🔄 Rate-limit counters reset for agent_API_poll.');
  };

  const runPIIRedactionScenario = async () => {
    const res = await guardrails.execute<{
      synced: boolean;
      handlerReceivedUnredactedKey: boolean;
    }>('sync_customer_kyc', {
      customerNote:
        'Contact sarah.connor@cyberdyne.io, card 4532 0151 1283 0366, SSN 123-45-6789, tel +1-555-839-2001',
      apiKey: 'Bearer sk_live_secret_99887766',
    });

    if (res.success) {
      setLastBanner(
        '🔒 KYC executed! Inspect the Audit Telemetry Feed below to see automatic PII masking.',
      );
    }
  };

  return (
    <AgentApprovalProvider registry={guardrails}>
      <View style={styles.screen}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Header */}
          <View style={styles.headerBlock}>
            <View style={styles.versionBadge}>
              <Text style={styles.versionBadgeText}>
                react-native-agent-guard v0.3.2
              </Text>
            </View>
            <Text style={styles.title}>Mobile AI Agent Guardrails</Text>
            <Text style={styles.subtitle}>
              Interactive playground: Dynamic Policies • Loop Rate Limiting •
              PII Redaction • Vercel AI & MCP
            </Text>
          </View>

          {/* Status Banner */}
          <View style={styles.statusBanner}>
            <Text style={styles.statusBannerText}>{lastBanner}</Text>
          </View>
          <PendingQueueStatus />

          {/* Section 1: Dynamic Policy Routing */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>1. Dynamic Policy Routing</Text>
            <Text style={styles.cardHint}>
              Same tool (`send_payment`), 3 automatic security tiers based on
              parsed input amount:
            </Text>

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.btnAuto]}
                onPress={() => runPaymentScenario(25, 'Micro Transfer')}
              >
                <Text style={styles.btnLabel}>$25 • Auto</Text>
                <Text style={styles.btnSub}>{"< $50 -> 'auto'"}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionBtn, styles.btnConfirm]}
                onPress={() => runPaymentScenario(120, 'Standard Transfer')}
              >
                <Text style={styles.btnLabel}>$120 • Confirm</Text>
                <Text style={styles.btnSub}>{"$50-$199 -> Sheet"}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionBtn, styles.btnBio]}
                onPress={() => runPaymentScenario(450, 'High-Value Wire')}
              >
                <Text style={styles.btnLabel}>$450 • Biometric</Text>
                <Text style={styles.btnSub}>{"$200+ -> FaceID"}</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Section 2: Agent Loop Protection */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              2. Agent Loop Protection (`rateLimit`)
            </Text>
            <Text style={styles.cardHint}>
              `maxCallsPerMinute: 2` with `onLimitExceeded: &apos;confirm&apos;`.
              Tap 3+ times to see automatic policy escalation!
            </Text>

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.btnLoop]}
                onPress={runLoopSpamScenario}
              >
                <Text style={styles.btnLabel}>
                  Spam Agent Poll ({loopCount}/2 auto)
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionBtn, styles.btnSecondary]}
                onPress={resetLoopQuota}
              >
                <Text style={styles.btnLabel}>Reset Quota</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Section 3: PII Redaction & Vercel AI Export */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              3. PII Redaction & Framework Exports
            </Text>
            <Text style={styles.cardHint}>
              Masks emails, cards, SSNs, phones, and Bearer tokens in `onAudit`
              without mutating handler args.
            </Text>

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.btnPii]}
                onPress={runPIIRedactionScenario}
              >
                <Text style={styles.btnLabel}>Emit PII Payload</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionBtn, styles.btnSecondary]}
                onPress={() => setShowAdapterPreview((v) => !v)}
              >
                <Text style={styles.btnLabel}>
                  {showAdapterPreview ? 'Hide Schemas' : 'toVercelAITools()'}
                </Text>
              </TouchableOpacity>
            </View>

            {showAdapterPreview ? (
              <View style={styles.codeBox}>
                <Text style={styles.codeBoxText}>{adapterPreviewJson}</Text>
              </View>
            ) : null}
          </View>

          {/* Section 4: Live Sanitized Audit Telemetry Feed */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              4. Live `onAudit` Telemetry Stream ({auditFeed.length})
            </Text>
            {auditFeed.length === 0 ? (
              <Text style={styles.emptyAudit}>
                No tool executions yet. Tap any button above to emit telemetry.
              </Text>
            ) : (
              auditFeed.map((item) => (
                <View key={item.id} style={styles.auditItem}>
                  <View style={styles.auditHeader}>
                    <Text style={styles.auditTool}>{item.toolName}</Text>
                    <Text style={styles.auditBadge}>
                      {item.policy?.toUpperCase()} →{' '}
                      {item.outcome.toUpperCase()} ({item.duration}ms)
                    </Text>
                  </View>
                  <Text style={styles.auditArgs}>
                    args: {JSON.stringify(item.arguments)}
                  </Text>
                </View>
              ))
            )}
          </View>
        </ScrollView>

        {/* Ready-made dark-mode confirmation modal sheet */}
        <AgentApprovalSheet
          colorScheme="dark"
          title="Approve AI Agent Tool Call"
        />
      </View>
    </AgentApprovalProvider>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#090D16',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 40,
  },
  headerBlock: {
    marginBottom: 14,
  },
  versionBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#1E293B',
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    marginBottom: 8,
  },
  versionBadgeText: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '700',
  },
  title: {
    color: '#F8FAFC',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 4,
  },
  subtitle: {
    color: '#94A3B8',
    fontSize: 13,
    lineHeight: 18,
  },
  statusBanner: {
    backgroundColor: '#0F172A',
    borderColor: '#1E293B',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  statusBannerText: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '600',
  },
  queueBanner: {
    backgroundColor: '#1E1B4B',
    borderColor: '#4338CA',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 14,
  },
  queueBannerText: {
    color: '#C7D2FE',
    fontSize: 12,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#111827',
    borderColor: '#1F2937',
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginBottom: 14,
  },
  cardTitle: {
    color: '#F9FAFB',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  cardHint: {
    color: '#9CA3AF',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 11,
    paddingHorizontal: 8,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnAuto: {
    backgroundColor: '#059669',
  },
  btnConfirm: {
    backgroundColor: '#2563EB',
  },
  btnBio: {
    backgroundColor: '#7C3AED',
  },
  btnLoop: {
    backgroundColor: '#D97706',
    flex: 2,
  },
  btnPii: {
    backgroundColor: '#0D9488',
  },
  btnSecondary: {
    backgroundColor: '#334155',
  },
  btnLabel: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  btnSub: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 10,
    marginTop: 2,
  },
  codeBox: {
    backgroundColor: '#090D16',
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
    borderColor: '#1E293B',
    borderWidth: 1,
  },
  codeBoxText: {
    color: '#A5F3FC',
    fontSize: 11,
    fontFamily: 'Courier',
  },
  emptyAudit: {
    color: '#64748B',
    fontSize: 12,
    fontStyle: 'italic',
  },
  auditItem: {
    backgroundColor: '#090D16',
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
    borderColor: '#1E293B',
    borderWidth: 1,
  },
  auditHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  auditTool: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
  },
  auditBadge: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '600',
  },
  auditArgs: {
    color: '#94A3B8',
    fontSize: 11,
    fontFamily: 'Courier',
  },
});
