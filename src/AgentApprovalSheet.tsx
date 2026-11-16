import React, { useMemo } from 'react';
import {
  Appearance,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  useColorScheme,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useAgentApproval } from './ApprovalContext';
import { normalizeValue } from './canonical';
import type { SessionGrantOption } from './types';

export const DEFAULT_SESSION_GRANT_OPTIONS: SessionGrantOption[] = [
  { label: 'Approve Once', durationMs: 0 },
  { label: 'Allow for 5 mins', durationMs: 300_000 },
];

function formatDiffValue(val: unknown): string {
  if (val === undefined) {
    return 'none';
  }
  if (typeof val === 'string') {
    return val;
  }
  try {
    return JSON.stringify(normalizeValue(val));
  } catch {
    return String(val);
  }
}

/**
 * Theme color tokens for `<AgentApprovalSheet />`.
 * Can be partially overridden via the `theme` prop to match the host app's design system.
 */
export interface AgentApprovalSheetTheme {
  backdropColor: string;
  sheetBackground: string;
  titleColor: string;
  badgeBackground: string;
  badgeTextColor: string;
  sectionLabelColor: string;
  toolNameColor: string;
  descriptionColor: string;
  codeBackground: string;
  codeBorderColor: string;
  codeTextColor: string;
  denyButtonBackground: string;
  denyButtonTextColor: string;
  approveButtonBackground: string;
  approveButtonTextColor: string;
}

export const LIGHT_APPROVAL_SHEET_THEME: AgentApprovalSheetTheme = {
  backdropColor: 'rgba(15, 23, 42, 0.6)',
  sheetBackground: '#FFFFFF',
  titleColor: '#0F172A',
  badgeBackground: '#E2E8F0',
  badgeTextColor: '#334155',
  sectionLabelColor: '#64748B',
  toolNameColor: '#1E293B',
  descriptionColor: '#475569',
  codeBackground: '#F8FAFC',
  codeBorderColor: '#E2E8F0',
  codeTextColor: '#0F172A',
  denyButtonBackground: '#FEE2E2',
  denyButtonTextColor: '#B91C1C',
  approveButtonBackground: '#16A34A',
  approveButtonTextColor: '#FFFFFF',
};

export const DARK_APPROVAL_SHEET_THEME: AgentApprovalSheetTheme = {
  backdropColor: 'rgba(2, 6, 23, 0.78)',
  sheetBackground: '#0F172A',
  titleColor: '#F8FAFC',
  badgeBackground: '#1E293B',
  badgeTextColor: '#CBD5E1',
  sectionLabelColor: '#94A3B8',
  toolNameColor: '#F1F5F9',
  descriptionColor: '#CBD5E1',
  codeBackground: '#1E293B',
  codeBorderColor: '#334155',
  codeTextColor: '#E2E8F0',
  denyButtonBackground: '#450A0A',
  denyButtonTextColor: '#FCA5A5',
  approveButtonBackground: '#22C55E',
  approveButtonTextColor: '#052E16',
};

export interface AgentApprovalSheetProps {
  /** Optional custom header title. Defaults to `"Agent Action Approval"`. */
  title?: string;
  /** Optional custom label for the Approve button. Defaults to `"Approve"`. */
  approveLabel?: string;
  /** Optional custom label for the Deny button. Defaults to `"Deny"`. */
  denyLabel?: string;
  /**
   * Color scheme override (`'light' | 'dark' | 'system'`).
   * Defaults to `'system'` (automatically detected via `useColorScheme()` / `Appearance.getColorScheme()`).
   */
  colorScheme?: 'light' | 'dark' | 'system';
  /** Partial theme color overrides merged on top of the active light/dark palette. */
  theme?: Partial<AgentApprovalSheetTheme>;
  /** Custom style for the modal backdrop / outer container. */
  containerStyle?: StyleProp<ViewStyle>;
  /** Custom style for the bottom sheet card container. */
  sheetStyle?: StyleProp<ViewStyle>;
  /** Custom style for the header title text. */
  titleStyle?: StyleProp<TextStyle>;
  /** Custom style for section labels ("TOOL NAME", "DESCRIPTION", "ARGUMENTS"). */
  sectionLabelStyle?: StyleProp<TextStyle>;
  /** Custom style for the tool name text. */
  toolNameStyle?: StyleProp<TextStyle>;
  /** Custom style for the tool description text. */
  descriptionStyle?: StyleProp<TextStyle>;
  /** Custom style for the JSON arguments code container. */
  codeBlockStyle?: StyleProp<ViewStyle>;
  /** Custom style for the JSON arguments monospace text. */
  codeTextStyle?: StyleProp<TextStyle>;
  /** Shared custom style applied to both Approve and Deny action buttons. */
  buttonStyle?: StyleProp<ViewStyle>;
  /** Custom style specifically for the Approve button. */
  approveButtonStyle?: StyleProp<ViewStyle>;
  /** Custom style specifically for the Deny button. */
  denyButtonStyle?: StyleProp<ViewStyle>;
  /** Custom text style for the Approve button label. */
  approveTextStyle?: StyleProp<TextStyle>;
  /** Custom text style for the Deny button label. */
  denyTextStyle?: StyleProp<TextStyle>;
  /**
   * When `true`, renders quick-action session grant buttons (defaults to `"Approve Once"` and `"Allow for 5 mins"`).
   */
  enableSessionGrants?: boolean;
  /**
   * Custom session grant options to display in the sheet (overrides `enableSessionGrants` defaults).
   */
  sessionGrantOptions?: SessionGrantOption[];
  /**
   * Optional callback invoked when the user approves the request (receives chosen `durationMs` when a session grant button is tapped).
   */
  onApprove?: (durationMs?: number | 'session') => void;
}

/**
 * Ready-made, zero-dependency React Native confirmation bottom sheet / modal
 * that automatically presents whenever `currentRequest` in `<AgentApprovalProvider>` is non-null.
 * Automatically adapts to light and dark mode and supports full style and theme overrides.
 */
export const AgentApprovalSheet: React.FC<AgentApprovalSheetProps> = ({
  title = 'Agent Action Approval',
  approveLabel = 'Approve',
  denyLabel = 'Deny',
  colorScheme = 'system',
  theme,
  containerStyle,
  sheetStyle,
  titleStyle,
  sectionLabelStyle,
  toolNameStyle,
  descriptionStyle,
  codeBlockStyle,
  codeTextStyle,
  buttonStyle,
  approveButtonStyle,
  denyButtonStyle,
  approveTextStyle,
  denyTextStyle,
  enableSessionGrants = false,
  sessionGrantOptions,
  onApprove,
}) => {
  const { currentRequest, queueLength, approve, deny } = useAgentApproval();
  const hookScheme =
    typeof useColorScheme === 'function' ? useColorScheme() : null;
  const systemScheme =
    hookScheme ??
    (typeof Appearance?.getColorScheme === 'function'
      ? Appearance.getColorScheme()
      : 'light');

  const isDark =
    colorScheme === 'dark' ||
    (colorScheme === 'system' && systemScheme === 'dark');

  const resolvedTheme = useMemo<AgentApprovalSheetTheme>(
    () => ({
      ...(isDark ? DARK_APPROVAL_SHEET_THEME : LIGHT_APPROVAL_SHEET_THEME),
      ...theme,
    }),
    [isDark, theme],
  );

  if (!currentRequest) {
    return null;
  }

  const rawPreviewSource =
    currentRequest.canonicalArgs ??
    currentRequest.args ??
    currentRequest.input ??
    {};

  let formattedArgs = '{}';
  try {
    const normalizedPreview =
      currentRequest.canonicalArgs !== undefined
        ? currentRequest.canonicalArgs
        : normalizeValue(rawPreviewSource);
    formattedArgs = JSON.stringify(normalizedPreview ?? {}, null, 2);
  } catch {
    try {
      formattedArgs = JSON.stringify(rawPreviewSource, null, 2);
    } catch {
      formattedArgs = String(rawPreviewSource);
    }
  }

  const activeGrantOptions: SessionGrantOption[] | undefined =
    sessionGrantOptions ??
    currentRequest.sessionGrantOptions ??
    (enableSessionGrants ? DEFAULT_SESSION_GRANT_OPTIONS : undefined);

  const handlePrimaryApprove = () => {
    approve();
    onApprove?.(undefined);
  };

  const handleGrantApprove = (option: SessionGrantOption) => {
    if (option.durationMs === 0) {
      approve();
      onApprove?.(0);
      return;
    }
    approve(option.durationMs, {
      ...(option.maxCalls !== undefined ? { maxCalls: option.maxCalls } : {}),
    });
    onApprove?.(option.durationMs);
  };

  return (
    <Modal
      visible={true}
      transparent={true}
      animationType="slide"
      onRequestClose={deny}
    >
      <View
        style={[
          styles.backdrop,
          { backgroundColor: resolvedTheme.backdropColor },
          containerStyle,
        ]}
      >
        <View
          style={[
            styles.sheetContainer,
            { backgroundColor: resolvedTheme.sheetBackground },
            sheetStyle,
          ]}
        >
          <View style={styles.headerRow}>
            <Text
              style={[
                styles.headerTitle,
                { color: resolvedTheme.titleColor },
                titleStyle,
              ]}
            >
              {title}
            </Text>
            {queueLength > 1 ? (
              <View
                style={[
                  styles.queueBadge,
                  { backgroundColor: resolvedTheme.badgeBackground },
                ]}
              >
                <Text
                  style={[
                    styles.queueBadgeText,
                    { color: resolvedTheme.badgeTextColor },
                  ]}
                >
                  1 of {queueLength}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.metaSection}>
            <Text
              style={[
                styles.sectionLabel,
                { color: resolvedTheme.sectionLabelColor },
                sectionLabelStyle,
              ]}
            >
              TOOL NAME
            </Text>
            <Text
              style={[
                styles.toolName,
                { color: resolvedTheme.toolNameColor },
                toolNameStyle,
              ]}
            >
              {currentRequest.toolName}
            </Text>

            <Text
              style={[
                styles.sectionLabel,
                { color: resolvedTheme.sectionLabelColor },
                sectionLabelStyle,
              ]}
            >
              DESCRIPTION
            </Text>
            <Text
              style={[
                styles.description,
                { color: resolvedTheme.descriptionColor },
                descriptionStyle,
              ]}
            >
              {currentRequest.description}
            </Text>

            {currentRequest.threats && currentRequest.threats.length > 0 ? (
              <View style={styles.threatWarningBox}>
                <Text style={styles.threatWarningTitle}>
                  ⚠️ SECURITY WARNING ({currentRequest.threats.length} threat
                  {currentRequest.threats.length > 1 ? 's' : ''} detected)
                </Text>
                {currentRequest.threats.map((threat, idx) => (
                  <Text
                    key={`${threat.category}_${threat.fieldPath}_${idx}`}
                    style={styles.threatWarningItem}
                  >
                    • [{threat.category}] {threat.fieldPath}: {threat.message}
                  </Text>
                ))}
              </View>
            ) : null}

            {currentRequest.previewResult !== undefined ||
            currentRequest.previewError !== undefined ? (
              <View>
                <Text
                  style={[
                    styles.sectionLabel,
                    { color: resolvedTheme.sectionLabelColor },
                    sectionLabelStyle,
                  ]}
                >
                  IMPACT PREVIEW / DRY-RUN DIFF
                </Text>
                <View
                  style={[
                    styles.codeBlock,
                    {
                      backgroundColor: resolvedTheme.codeBackground,
                      borderColor: resolvedTheme.codeBorderColor,
                    },
                    codeBlockStyle,
                  ]}
                >
                  {currentRequest.previewError ? (
                    <Text
                      style={[
                        styles.codeText,
                        { color: resolvedTheme.denyButtonTextColor },
                      ]}
                    >
                      Preview unavailable: {currentRequest.previewError}
                    </Text>
                  ) : typeof currentRequest.previewResult === 'string' ? (
                    <Text
                      style={[
                        styles.codeText,
                        { color: resolvedTheme.codeTextColor },
                        codeTextStyle,
                      ]}
                    >
                      {currentRequest.previewResult}
                    </Text>
                  ) : (
                    <View>
                      {currentRequest.previewResult?.riskLevel ? (
                        <Text
                          style={[
                            styles.riskBadgeText,
                            { color: resolvedTheme.badgeTextColor },
                          ]}
                        >
                          RISK:{' '}
                          {currentRequest.previewResult.riskLevel.toUpperCase()}
                        </Text>
                      ) : null}
                      {currentRequest.previewResult?.summary ? (
                        <Text
                          style={[
                            styles.previewSummaryText,
                            { color: resolvedTheme.toolNameColor },
                          ]}
                        >
                          {currentRequest.previewResult.summary}
                        </Text>
                      ) : null}
                      {currentRequest.previewResult?.changes?.map((change) => (
                        <Text
                          key={change.field}
                          style={[
                            styles.codeText,
                            { color: resolvedTheme.codeTextColor },
                            codeTextStyle,
                          ]}
                        >
                          {change.field}: {formatDiffValue(change.before)} {'->'}{' '}
                          {formatDiffValue(change.after)}
                        </Text>
                      ))}
                      {currentRequest.previewResult?.before !== undefined ||
                      currentRequest.previewResult?.after !== undefined ? (
                        <Text
                          style={[
                            styles.codeText,
                            { color: resolvedTheme.codeTextColor },
                            codeTextStyle,
                          ]}
                        >
                          Before:{' '}
                          {formatDiffValue(currentRequest.previewResult?.before)}{' '}
                          {'->'} After:{' '}
                          {formatDiffValue(currentRequest.previewResult?.after)}
                        </Text>
                      ) : null}
                    </View>
                  )}
                </View>
              </View>
            ) : null}

            <Text
              style={[
                styles.sectionLabel,
                { color: resolvedTheme.sectionLabelColor },
                sectionLabelStyle,
              ]}
            >
              ARGUMENTS (JSON)
            </Text>
            <View
              style={[
                styles.codeBlock,
                {
                  backgroundColor: resolvedTheme.codeBackground,
                  borderColor: resolvedTheme.codeBorderColor,
                },
                codeBlockStyle,
              ]}
            >
              <Text
                style={[
                  styles.codeText,
                  { color: resolvedTheme.codeTextColor },
                  codeTextStyle,
                ]}
              >
                {formattedArgs}
              </Text>
            </View>
          </View>

          <View style={styles.actionsRow}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={denyLabel}
              style={[
                styles.button,
                { backgroundColor: resolvedTheme.denyButtonBackground },
                buttonStyle,
                denyButtonStyle,
              ]}
              onPress={deny}
              activeOpacity={0.8}
            >
              <Text
                style={[
                  styles.denyButtonText,
                  { color: resolvedTheme.denyButtonTextColor },
                  denyTextStyle,
                ]}
              >
                {denyLabel}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={approveLabel}
              style={[
                styles.button,
                { backgroundColor: resolvedTheme.approveButtonBackground },
                buttonStyle,
                approveButtonStyle,
              ]}
              onPress={handlePrimaryApprove}
              activeOpacity={0.8}
            >
              <Text
                style={[
                  styles.approveButtonText,
                  { color: resolvedTheme.approveButtonTextColor },
                  approveTextStyle,
                ]}
              >
                {approveLabel}
              </Text>
            </TouchableOpacity>
          </View>

          {activeGrantOptions && activeGrantOptions.length > 0 ? (
            <View style={styles.grantOptionsRow}>
              {activeGrantOptions.map((option) => (
                <TouchableOpacity
                  key={`${option.label}_${String(option.durationMs)}`}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  style={[
                    styles.grantOptionButton,
                    {
                      backgroundColor: resolvedTheme.badgeBackground,
                      borderColor: resolvedTheme.codeBorderColor,
                    },
                  ]}
                  onPress={() => handleGrantApprove(option)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[
                      styles.grantOptionText,
                      { color: resolvedTheme.badgeTextColor },
                    ]}
                  >
                    {option.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetContainer: {
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
  },
  queueBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  queueBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  metaSection: {
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginBottom: 4,
    marginTop: 10,
  },
  toolName: {
    fontSize: 16,
    fontWeight: '600',
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
  },
  codeBlock: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 4,
  },
  codeText: {
    fontSize: 13,
    fontFamily: 'Courier',
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
  denyButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  approveButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  grantOptionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  grantOptionButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grantOptionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  threatWarningBox: {
    backgroundColor: '#450A0A',
    borderColor: '#DC2626',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
  },
  threatWarningTitle: {
    color: '#FCA5A5',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  threatWarningItem: {
    color: '#FECACA',
    fontSize: 12,
    marginTop: 2,
  },
  riskBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
  },
  previewSummaryText: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 4,
  },
});
