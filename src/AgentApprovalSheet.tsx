import React from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAgentApproval } from './ApprovalContext';

export interface AgentApprovalSheetProps {
  /** Optional custom header title. Defaults to `"Agent Action Approval"`. */
  title?: string;
  /** Optional custom label for the Approve button. Defaults to `"Approve"`. */
  approveLabel?: string;
  /** Optional custom label for the Deny button. Defaults to `"Deny"`. */
  denyLabel?: string;
}

/**
 * Ready-made, zero-dependency React Native confirmation bottom sheet / modal
 * that automatically presents whenever `currentRequest` in `<AgentApprovalProvider>` is non-null.
 */
export const AgentApprovalSheet: React.FC<AgentApprovalSheetProps> = ({
  title = 'Agent Action Approval',
  approveLabel = 'Approve',
  denyLabel = 'Deny',
}) => {
  const { currentRequest, queueLength, approve, deny } = useAgentApproval();

  if (!currentRequest) {
    return null;
  }

  let formattedArgs = '{}';
  try {
    formattedArgs = JSON.stringify(currentRequest.input ?? {}, null, 2);
  } catch {
    formattedArgs = String(currentRequest.input);
  }

  return (
    <Modal
      visible={true}
      transparent={true}
      animationType="slide"
      onRequestClose={deny}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheetContainer}>
          <View style={styles.headerRow}>
            <Text style={styles.headerTitle}>{title}</Text>
            {queueLength > 1 ? (
              <View style={styles.queueBadge}>
                <Text style={styles.queueBadgeText}>
                  1 of {queueLength}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.metaSection}>
            <Text style={styles.sectionLabel}>TOOL NAME</Text>
            <Text style={styles.toolName}>{currentRequest.toolName}</Text>

            <Text style={styles.sectionLabel}>DESCRIPTION</Text>
            <Text style={styles.description}>
              {currentRequest.description}
            </Text>

            <Text style={styles.sectionLabel}>ARGUMENTS (JSON)</Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>{formattedArgs}</Text>
            </View>
          </View>

          <View style={styles.actionsRow}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={denyLabel}
              style={[styles.button, styles.denyButton]}
              onPress={deny}
              activeOpacity={0.8}
            >
              <Text style={styles.denyButtonText}>{denyLabel}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={approveLabel}
              style={[styles.button, styles.approveButton]}
              onPress={approve}
              activeOpacity={0.8}
            >
              <Text style={styles.approveButtonText}>{approveLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 32,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
  },
  queueBadge: {
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  queueBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },
  metaSection: {
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 0.6,
    marginBottom: 4,
    marginTop: 10,
  },
  toolName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1E293B',
  },
  description: {
    fontSize: 14,
    color: '#475569',
    lineHeight: 20,
  },
  codeBlock: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    padding: 12,
    marginTop: 4,
  },
  codeText: {
    fontSize: 13,
    fontFamily: 'Courier',
    color: '#0F172A',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  denyButton: {
    backgroundColor: '#FEE2E2',
  },
  denyButtonText: {
    color: '#B91C1C',
    fontSize: 15,
    fontWeight: '700',
  },
  approveButton: {
    backgroundColor: '#16A34A',
  },
  approveButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});
