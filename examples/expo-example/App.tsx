import React from 'react';
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
  AgentApprovalProvider, 
  AgentApprovalSheet 
} from 'react-native-agent-guard';
import { z } from 'zod';

// 1. Initialize the GuardrailRegistry using createGuardrails and register tools
// with 'confirm' (UI sheet) and 'biometric' (native FaceID / TouchID) policies.
const registry: GuardrailRegistry = createGuardrails({
  defaultPolicy: 'confirm',
  biometricOptions: {
    promptMessage: (req) => `Verify FaceID / TouchID to run ${req.toolName}`,
    cancelLabel: 'Cancel',
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
    inputSchema: z.object({
      recipient: z.string(),
      amountGBP: z.number().positive(),
    }),
    policy: 'confirm', // <--- Triggers the in-app AgentApprovalSheet modal!
    handler: async ({ recipient, amountGBP }) => {
      // Runs only AFTER the user taps "Approve" on the UI sheet
      return { success: true, txId: 'tx_live_998877', recipient, amountGBP };
    },
  })
  .register('wire_transfer_biometric', {
    description: 'Send a high-value £5,000 international wire transfer',
    inputSchema: z.object({
      recipient: z.string(),
      iban: z.string(),
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

export default function App() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

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
});