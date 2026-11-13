import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Alert,
  Platform,
  useColorScheme,
} from 'react-native';
import { 
  createGuardrails, 
  type GuardrailRegistry,
  type AuditTelemetryEvent,
  AgentApprovalProvider, 
  AgentApprovalSheet 
} from 'react-native-agent-guard';
import { z } from 'zod';

// 1. Initialize the GuardrailRegistry using createGuardrails and register tools
// with 'confirm' (UI sheet), 'biometric' (native FaceID / TouchID), `rateLimit` loop protection, and an `onAudit` telemetry hook.
const registry: GuardrailRegistry = createGuardrails({
  defaultPolicy: 'confirm',
  rateLimit: {
    maxCallsPerMinute: 5,
    maxSessionCalls: 10,
    onLimitExceeded: 'deny',
  },
  // Automatically mask PII (emails, phones, cards, SSNs, tokens) and custom sensitive keys in audit telemetry
  redactPII: {
    enabled: true,
    sensitiveKeys: ['iban'],
  },
  biometricOptions: {
    promptMessage: (req) => `Verify FaceID / TouchID to run ${req.toolName}`,
    cancelLabel: 'Cancel',
  },
  onAudit: (event) => {
    console.log(
      `[AgentGuard Audit] ${event.isoTimestamp} | tool=${event.toolName} | policy=${event.policy ?? 'n/a'} | outcome=${event.outcome} (${event.status}) | ${event.duration}ms`,
      event.arguments,
    );
  },
  checkPermission: (toolName) => {
    if (toolName === 'wire_transfer_biometric') {
      return 'biometric';
    }
    if (toolName === 'transfer_funds') {
      return 'confirm';
    }
    return true;
  },
})
  .register('transfer_funds', {
    description: 'Transfer £150 to a saved beneficiary account',
    inputSchema: z
      .object({
        recipient: z
          .string()
          .min(1)
          .transform((name) => name.trim()),
        amountGBP: z
          .number()
          .positive()
          .refine((amt) => amt <= 2500, {
            message: 'Standard transfers cannot exceed £2,500',
          }),
      })
      .refine((data) => data.recipient.toLowerCase() !== 'restricted', {
        message: 'Transfers to restricted accounts are blocked',
        path: ['recipient'],
      }),
    policy: 'confirm', // <--- Triggers the in-app AgentApprovalSheet modal!
    rateLimit: {
      maxCallsPerMinute: 3,
      maxSessionCalls: 5,
      onLimitExceeded: 'deny',
    },
    handler: async ({ recipient, amountGBP }) => {
      // Runs only AFTER the user taps "Approve" on the UI sheet
      return { success: true, txId: 'tx_live_998877', recipient, amountGBP };
    },
  })
  .register('wire_transfer_biometric', {
    description: 'Send a high-value £5,000 international wire transfer',
    inputSchema: z.object({
      recipient: z
        .string()
        .min(1)
        .transform((val) => val.trim()),
      iban: z
        .string()
        .min(10)
        .transform((val) => val.replace(/\s+/g, '').toUpperCase())
        .refine((val) => /^[A-Z]{2}[0-9A-Z]+$/.test(val), {
          message: 'IBAN must start with a 2-letter country code',
        }),
      amountGBP: z.number().positive(),
    }),
    policy: 'biometric', // <--- Triggers native FaceID / TouchID via expo-local-authentication!
    handler: async ({ recipient, iban, amountGBP }) => {
      // Runs only AFTER native FaceID / TouchID succeeds
      return {
        success: true,
        txId: 'tx_bio_445566',
        recipient,
        iban,
        amountGBP,
      };
    },
  });

// Export strict OpenAI and Claude tool schemas (safely handling .transform() & .refine())
export const openAIToolsPayload = registry.toOpenAITools({ strict: true });
export const claudeToolsPayload = registry.toClaudeTools({ strict: true });

// Export ready-to-use Vercel AI SDK and LangChain.js tool adapters
export const vercelAITools = registry.toVercelAITools({ unwrapData: true });
export const langChainTools = registry.toLangChainTools({ unwrapData: true });

export default function App() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [auditHistory, setAuditHistory] = useState<AuditTelemetryEvent[]>([]);

  useEffect(() => {
    // Subscribe to real-time execution audit telemetry events for UI state
    return registry.onAudit((event) => {
      setAuditHistory((prev) => [event, ...prev.slice(0, 2)]);
    });
  }, []);

  const handleTriggerAIAgentAction = async () => {
    console.log('AI Agent is attempting to call confirm tool...');
    
    // Execute the tool call (this returns a Promise that pauses for UI approval)
    const result = await registry.execute<{
      success: boolean;
      txId: string;
      recipient: string;
      amountGBP: number;
    }>('transfer_funds', {
      recipient: 'Sarah Connor',
      amountGBP: 150.0,
    });

    if (result.success && result.data) {
      Alert.alert('Success!', `Transaction ID: ${result.data.txId}`);
    } else {
      Alert.alert('Action Blocked', `Result: ${result.code} - ${result.llmFeedback}`);
    }
  };

  const handleTriggerBiometricAction = async () => {
    console.log('AI Agent is attempting to call biometric tool...');

    // Execute the biometric-gated tool (triggers native FaceID / TouchID)
    const result = await registry.execute<{
      success: boolean;
      txId: string;
      recipient: string;
      iban: string;
      amountGBP: number;
    }>('wire_transfer_biometric', {
      recipient: 'Cyberdyne Systems',
      iban: 'GB29NWBK60161331926819',
      amountGBP: 5000.0,
    });

    if (result.success && result.data) {
      Alert.alert('Biometric Wire Approved!', `Transaction ID: ${result.data.txId}`);
    } else {
      Alert.alert('Biometric Gate Blocked', `Result: ${result.code} - ${result.llmFeedback}`);
    }
  };

  const handleConnectAndRunMCPTool = async () => {
    console.log('Connecting to remote MCP SSE endpoint...');

    try {
      // Connect to an MCP SSE endpoint, auto-discover tools, and register them into GuardrailRegistry
      const { tools } = await registry.connectMCP({
        url: 'https://mcp.demo.agent-guard.dev/sse',
        defaultPolicy: 'confirm',
        // Fallback demo SSE responder if the external server is unreachable offline
        fetchFn: async (input, init) => {
          try {
            return await fetch(input, init);
          } catch {
            if (!init?.method || init.method === 'GET') {
              return new Response(
                'event: endpoint\ndata: https://mcp.demo.agent-guard.dev/messages\n\n',
                { headers: { 'content-type': 'text/event-stream' } },
              );
            }
            const rpc = JSON.parse(String(init.body));
            if (rpc.method === 'initialize') {
              return new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: rpc.id,
                  result: { protocolVersion: '2024-11-05' },
                }),
                { headers: { 'content-type': 'application/json' } },
              );
            }
            if (rpc.method === 'tools/list') {
              return new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: rpc.id,
                  result: {
                    tools: [
                      {
                        name: 'mcp_cloud_deploy',
                        description:
                          'Deploy mobile release bundle via remote MCP server',
                        inputSchema: {
                          type: 'object',
                          properties: {
                            environment: {
                              type: 'string',
                              enum: ['staging', 'production'],
                            },
                            versionTag: { type: 'string' },
                          },
                          required: ['environment', 'versionTag'],
                        },
                      },
                    ],
                  },
                }),
                { headers: { 'content-type': 'application/json' } },
              );
            }
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  deploymentId: 'dep_mcp_778899',
                  status: 'DEPLOYED',
                  args: rpc.params?.arguments,
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          }
        },
      });

      const discoveredName = tools[0]?.name ?? 'mcp_cloud_deploy';
      const result = await registry.execute<{
        deploymentId: string;
        status: string;
      }>(discoveredName, {
        environment: 'production',
        versionTag: 'v0.1.4',
      });

      if (result.success && result.data) {
        Alert.alert(
          'MCP Tool Executed!',
          `Deployment ID: ${result.data.deploymentId} (${result.data.status})`,
        );
      } else {
        Alert.alert(
          'MCP Action Blocked',
          `Result: ${result.code} - ${result.llmFeedback}`,
        );
      }
    } catch (err) {
      Alert.alert(
        'MCP Connection Error',
        err instanceof Error ? err.message : 'Unknown error',
      );
    }
  };

  const handleRunFrameworkAdapterTool = async () => {
    console.log('Executing tool via Vercel AI SDK & LangChain adapter...');

    // Invoking vercelAITools.transfer_funds.execute() automatically routes through
    // GuardrailRegistry, pausing for AgentApprovalSheet confirmation and emitting onAudit telemetry!
    const adapterResult = (await vercelAITools.transfer_funds?.execute({
      recipient: 'John Connor',
      amountGBP: 85.0,
    })) as {
      success?: boolean;
      txId?: string;
      error?: string;
      llmFeedback?: string;
    };

    if (adapterResult && adapterResult.txId) {
      Alert.alert(
        'Vercel AI Adapter Success!',
        `Transaction ID: ${adapterResult.txId}`,
      );
    } else {
      Alert.alert(
        'Adapter Action Blocked',
        `Code: ${adapterResult?.error} - ${adapterResult?.llmFeedback}`,
      );
    }
  };

  return (
    // 2. Wrap your app tree with the AgentApprovalProvider
    <AgentApprovalProvider registry={registry}>
      <View style={[styles.container, isDark && styles.containerDark]}>
        <Text style={[styles.header, isDark && styles.headerDark]}>
          Agent Guard UI Test
        </Text>
        <Text style={[styles.subtext, isDark && styles.subtextDark]}>
          Test human-in-the-loop workflow for mobile AI agents ({isDark ? 'Dark' : 'Light'} Mode).
        </Text>

        <TouchableOpacity style={styles.button} onPress={handleTriggerAIAgentAction}>
          <Text style={styles.buttonText}>Simulate Confirm Tool (£150)</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.biometricButton]}
          onPress={handleTriggerBiometricAction}
        >
          <Text style={styles.buttonText}>Simulate Biometric Tool (£5,000)</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.mcpButton]}
          onPress={handleConnectAndRunMCPTool}
        >
          <Text style={styles.buttonText}>Connect MCP SSE & Run Tool</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.adapterButton]}
          onPress={handleRunFrameworkAdapterTool}
        >
          <Text style={styles.buttonText}>Run via Vercel AI / LangChain Adapter</Text>
        </TouchableOpacity>

        {auditHistory.length > 0 ? (
          <View style={[styles.auditCard, isDark && styles.auditCardDark]}>
            <Text style={[styles.auditTitle, isDark && styles.headerDark]}>
              Live Telemetry Stream ({auditHistory.length})
            </Text>
            {auditHistory.map((item) => (
              <View key={item.id} style={styles.auditRow}>
                <Text style={[styles.auditText, isDark && styles.subtextDark]}>
                  • {item.toolName} [{item.policy ?? 'n/a'}] →{' '}
                  {item.outcome.toUpperCase()} ({item.status}) • {item.duration}ms
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* 3. Place the ready-made approval sheet with custom styling & theme support */}
        <AgentApprovalSheet
          colorScheme={isDark ? 'dark' : 'light'}
          sheetStyle={styles.customSheet}
          titleStyle={styles.customSheetTitle}
          buttonStyle={styles.customSheetButton}
          theme={{
            approveButtonBackground: '#007AFF',
            approveButtonTextColor: '#FFFFFF',
          }}
        />
      </View>
    </AgentApprovalProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
    padding: 20,
  },
  containerDark: {
    backgroundColor: '#0B0F19',
  },
  header: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111',
    marginBottom: 8,
  },
  headerDark: {
    color: '#F8FAFC',
  },
  subtext: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginBottom: 30,
  },
  subtextDark: {
    color: '#94A3B8',
  },
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: Platform.OS === 'ios' ? 0.1 : 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  biometricButton: {
    backgroundColor: '#7C3AED',
  },
  mcpButton: {
    backgroundColor: '#0D9488',
  },
  adapterButton: {
    backgroundColor: '#EA580C',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  customSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
  },
  customSheetTitle: {
    fontSize: 20,
    letterSpacing: -0.3,
  },
  customSheetButton: {
    borderRadius: 14,
  },
  auditCard: {
    marginTop: 18,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#E2E8F0',
    width: '100%',
  },
  auditCardDark: {
    backgroundColor: '#1E293B',
  },
  auditTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 4,
  },
  auditRow: {
    marginTop: 2,
  },
  auditText: {
    fontSize: 12,
    color: '#334155',
  },
});