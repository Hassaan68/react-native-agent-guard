import type { ApprovalRequest, BiometricHandler } from './types';

/**
 * Minimal interface matching `expo-local-authentication` methods used for biometric gating.
 */
export interface ExpoLocalAuthenticationModule {
  hasHardwareAsync?: () => Promise<boolean>;
  isEnrolledAsync?: () => Promise<boolean>;
  authenticateAsync: (options?: {
    promptMessage?: string;
    cancelLabel?: string;
    disableDeviceFallback?: boolean;
    fallbackLabel?: string;
    requireConfirmation?: boolean;
  }) => Promise<{
    success: boolean;
    error?: string;
    warning?: string;
  }>;
}

/**
 * Configuration options for native biometric authentication prompts (FaceID / TouchID / Biometrics).
 */
export interface BiometricAuthOptions {
  /**
   * Custom message shown in the native FaceID / TouchID / Biometric dialog,
   * or a function generating the prompt message from the `ApprovalRequest`.
   */
  promptMessage?: string | ((request: ApprovalRequest) => string);
  /** Custom cancel button label on the native prompt. */
  cancelLabel?: string;
  /** Whether to disable falling back to device passcode/PIN. Defaults to `false`. */
  disableDeviceFallback?: boolean;
  /** iOS fallback button label when biometric recognition fails. */
  fallbackLabel?: string;
  /** Android option to require explicit confirmation after passive biometric (e.g. Face) unlock. */
  requireConfirmation?: boolean;
  /** Whether to verify `hasHardwareAsync()` and `isEnrolledAsync()` before prompting. Defaults to `true`. */
  checkEnrollment?: boolean;
}

declare const require: ((id: string) => unknown) | undefined;

function loadExpoLocalAuthentication(): ExpoLocalAuthenticationModule | null {
  try {
    if (typeof require === 'function') {
      const mod = require('expo-local-authentication') as
        | (ExpoLocalAuthenticationModule & {
            default?: ExpoLocalAuthenticationModule;
          })
        | undefined;
      if (mod && typeof mod.authenticateAsync === 'function') {
        return mod;
      }
      if (mod?.default && typeof mod.default.authenticateAsync === 'function') {
        return mod.default;
      }
    }
  } catch {
    // Module not installed or unavailable in current runtime
  }
  return null;
}

/**
 * Trigger native biometric authentication (FaceID / TouchID / Android Biometrics)
 * using `expo-local-authentication`.
 */
export async function authenticateWithExpoBiometrics(
  request: ApprovalRequest,
  options: BiometricAuthOptions = {},
): Promise<boolean> {
  const LocalAuthentication = loadExpoLocalAuthentication();
  if (!LocalAuthentication) {
    return false;
  }

  const shouldCheckEnrollment = options.checkEnrollment ?? true;

  if (shouldCheckEnrollment) {
    if (typeof LocalAuthentication.hasHardwareAsync === 'function') {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      if (!hasHardware) {
        return false;
      }
    }

    if (typeof LocalAuthentication.isEnrolledAsync === 'function') {
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      if (!isEnrolled) {
        return false;
      }
    }
  }

  const promptMessage =
    typeof options.promptMessage === 'function'
      ? options.promptMessage(request)
      : (options.promptMessage ??
        `Authenticate to execute "${request.toolName}"`);

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: options.cancelLabel ?? 'Cancel',
    disableDeviceFallback: options.disableDeviceFallback ?? false,
    ...(options.fallbackLabel ? { fallbackLabel: options.fallbackLabel } : {}),
    ...(options.requireConfirmation !== undefined
      ? { requireConfirmation: options.requireConfirmation }
      : {}),
  });

  return Boolean(result?.success);
}

/**
 * Factory helper creating a `BiometricHandler` backed by `expo-local-authentication`.
 */
export function createExpoBiometricHandler(
  options: BiometricAuthOptions = {},
): BiometricHandler {
  return (request: ApprovalRequest) =>
    authenticateWithExpoBiometrics(request, options);
}
