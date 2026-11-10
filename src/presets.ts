import { z } from 'zod';
import type { PolicyResolver, ToolDefinition } from './types';

// ---------------------------------------------------------------------------
// 1. Payment Tool Preset
// ---------------------------------------------------------------------------

export const paymentInputSchema = z.object({
  recipient: z
    .string()
    .min(1, 'Recipient identifier or address must not be empty.'),
  amount: z.number().positive('Payment amount must be greater than 0.'),
  currency: z
    .string()
    .length(3, 'Currency must be a 3-letter ISO-4217 code (e.g. USD).')
    .default('USD'),
  note: z.string().max(280).optional(),
});

export type PaymentToolInput = z.infer<typeof paymentInputSchema>;

export interface PaymentToolResult {
  transactionId: string;
  status: 'COMPLETED';
  recipient: string;
  amount: number;
  currency: string;
  timestamp: string;
}

export interface PaymentPresetOptions<TOutput = PaymentToolResult> {
  description?: string;
  /** Amounts less than or equal to this threshold auto-execute; higher amounts require `highValuePolicy`. Defaults to `50`. */
  autoApproveLimit?: number;
  /** Policy used when `amount > autoApproveLimit`. Defaults to `'biometric'`. */
  highValuePolicy?: 'confirm' | 'biometric';
  policy?: PolicyResolver<PaymentToolInput>;
  timeoutMs?: number;
  handler?: (
    input: PaymentToolInput,
  ) => TOutput | Promise<TOutput>;
}

export function createPaymentToolPreset<TOutput = PaymentToolResult>(
  options: PaymentPresetOptions<TOutput> = {},
): ToolDefinition<typeof paymentInputSchema, TOutput> & { name: string } {
  const autoApproveLimit = options.autoApproveLimit ?? 50;
  const highValuePolicy = options.highValuePolicy ?? 'biometric';

  const defaultHandler = async (
    input: PaymentToolInput,
  ): Promise<PaymentToolResult> => ({
    transactionId: `tx_${Date.now()}`,
    status: 'COMPLETED',
    recipient: input.recipient,
    amount: input.amount,
    currency: input.currency,
    timestamp: new Date().toISOString(),
  });

  return {
    name: 'send_payment',
    description:
      options.description ??
      'Send a mobile payment to a recipient with automatic policy escalation for high-value transfers.',
    inputSchema: paymentInputSchema,
    policy:
      options.policy ??
      ((input) =>
        input.amount <= autoApproveLimit ? 'auto' : highValuePolicy),
    timeoutMs: options.timeoutMs ?? 15_000,
    handler:
      options.handler ??
      (defaultHandler as unknown as (
        input: PaymentToolInput,
      ) => Promise<TOutput>),
  };
}

// ---------------------------------------------------------------------------
// 2. BLE Sync Tool Preset
// ---------------------------------------------------------------------------

export const bleSyncInputSchema = z.object({
  deviceId: z.string().min(1, 'BLE peripheral deviceId is required.'),
  serviceUuid: z
    .string()
    .min(4, 'BLE serviceUuid must be at least 4 characters.'),
  characteristicUuid: z.string().min(4).optional(),
  payloadHex: z
    .string()
    .regex(/^[0-9a-fA-F]*$/, 'payloadHex must be a valid hexadecimal string.')
    .optional(),
});

export type BleSyncToolInput = z.infer<typeof bleSyncInputSchema>;

export interface BleSyncToolResult {
  deviceId: string;
  serviceUuid: string;
  syncedBytes: number;
  status: 'SYNCED';
  timestamp: string;
}

export interface BleSyncPresetOptions<TOutput = BleSyncToolResult> {
  description?: string;
  policy?: PolicyResolver<BleSyncToolInput>;
  timeoutMs?: number;
  handler?: (
    input: BleSyncToolInput,
  ) => TOutput | Promise<TOutput>;
}

export function createBleSyncToolPreset<TOutput = BleSyncToolResult>(
  options: BleSyncPresetOptions<TOutput> = {},
): ToolDefinition<typeof bleSyncInputSchema, TOutput> & { name: string } {
  const defaultHandler = async (
    input: BleSyncToolInput,
  ): Promise<BleSyncToolResult> => ({
    deviceId: input.deviceId,
    serviceUuid: input.serviceUuid,
    syncedBytes: input.payloadHex ? Math.floor(input.payloadHex.length / 2) : 0,
    status: 'SYNCED',
    timestamp: new Date().toISOString(),
  });

  return {
    name: 'ble_sync_device',
    description:
      options.description ??
      'Connect and synchronize data with a nearby Bluetooth Low Energy (BLE) peripheral device.',
    inputSchema: bleSyncInputSchema,
    policy: options.policy ?? 'confirm',
    timeoutMs: options.timeoutMs ?? 20_000,
    handler:
      options.handler ??
      (defaultHandler as unknown as (
        input: BleSyncToolInput,
      ) => Promise<TOutput>),
  };
}

// ---------------------------------------------------------------------------
// 3. Calendar Event Tool Preset
// ---------------------------------------------------------------------------

export const calendarEventInputSchema = z.object({
  title: z.string().min(1, 'Event title is required.'),
  startIso: z.string().min(1, 'Event startIso timestamp is required.'),
  endIso: z.string().min(1, 'Event endIso timestamp is required.'),
  location: z.string().optional(),
  notes: z.string().optional(),
  attendees: z.array(z.string().email('Each attendee must be a valid email.')).optional(),
});

export type CalendarEventToolInput = z.infer<typeof calendarEventInputSchema>;

export interface CalendarEventToolResult {
  eventId: string;
  title: string;
  startIso: string;
  endIso: string;
  status: 'CREATED';
}

export interface CalendarEventPresetOptions<TOutput = CalendarEventToolResult> {
  description?: string;
  policy?: PolicyResolver<CalendarEventToolInput>;
  timeoutMs?: number;
  handler?: (
    input: CalendarEventToolInput,
  ) => TOutput | Promise<TOutput>;
}

export function createCalendarEventToolPreset<
  TOutput = CalendarEventToolResult,
>(
  options: CalendarEventPresetOptions<TOutput> = {},
): ToolDefinition<typeof calendarEventInputSchema, TOutput> & { name: string } {
  const defaultHandler = async (
    input: CalendarEventToolInput,
  ): Promise<CalendarEventToolResult> => ({
    eventId: `evt_${Date.now()}`,
    title: input.title,
    startIso: input.startIso,
    endIso: input.endIso,
    status: 'CREATED',
  });

  return {
    name: 'create_calendar_event',
    description:
      options.description ??
      'Schedule a new event in the user device calendar.',
    inputSchema: calendarEventInputSchema,
    policy:
      options.policy ??
      ((input) =>
        input.attendees && input.attendees.length > 0 ? 'confirm' : 'auto'),
    timeoutMs: options.timeoutMs ?? 10_000,
    handler:
      options.handler ??
      (defaultHandler as unknown as (
        input: CalendarEventToolInput,
      ) => Promise<TOutput>),
  };
}
