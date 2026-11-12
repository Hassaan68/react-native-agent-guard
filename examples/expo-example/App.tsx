import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Alert, Platform } from 'react-native';
import { 
  createGuardrails, 
  type GuardrailRegistry,
  AgentApprovalProvider, 
  AgentApprovalSheet 
} from 'react-native-agent-guard';
import { z } from 'zod';

// 1. Initialize the GuardrailRegistry using createGuardrails and register a tool with policy: 'confirm'
// This forces execution to pause and trigger the UI modal automatically.
const registry: GuardrailRegistry = createGuardrails({
  defaultPolicy: 'confirm',
  checkPermission: (toolName) => {
    if (toolName === 'transfer_funds') {
      return 'confirm';
    }
    return true;
  },
}).register('transfer_funds', {
  description: 'Transfer £150 to a saved beneficiary account',
  inputSchema: z.object({
    recipient: z.string(),
    amountGBP: z.number().positive(),
  }),
  policy: 'confirm', // <--- This triggers the UI approval sheet!
  handler: async ({ recipient, amountGBP }) => {
    // This only runs AFTER the user taps "Approve" on the UI sheet
    return { success: true, txId: 'tx_live_998877', recipient, amountGBP };
  },
});

export default function App() {
  const handleTriggerAIAgentAction = async () => {
    console.log('AI Agent is attempting to call tool...');
    
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

  return (
    // 2. Wrap your app tree with the AgentApprovalProvider
    <AgentApprovalProvider registry={registry}>
      <View style={styles.container}>
        <Text style={styles.header}>Agent Guard UI Test</Text>
        <Text style={styles.subtext}>
          Test human-in-the-loop workflow for mobile AI agents.
        </Text>

        <TouchableOpacity style={styles.button} onPress={handleTriggerAIAgentAction}>
          <Text style={styles.buttonText}>Simulate AI Agent Tool Call</Text>
        </TouchableOpacity>

        {/* 3. Place the ready-made approval sheet anywhere inside the provider */}
        <AgentApprovalSheet />
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
  header: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111',
    marginBottom: 8,
  },
  subtext: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginBottom: 30,
  },
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: Platform.OS === 'ios' ? 0.1 : 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});