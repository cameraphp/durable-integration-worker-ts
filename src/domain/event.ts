import { z } from 'zod';

/** Synthetic event types only. This reference implementation never accepts real-world payloads. */
export const EVENT_TYPES = ['synthetic.order.created', 'synthetic.invoice.issued', 'synthetic.ticket.updated'] as const;

/**
 * Closed set of mock-adapter outcomes for demos. Honoured only when the SERVER enables
 * MOCK_SCENARIOS_ENABLED. Clients can never choose retry limits, delays, states, paths or adapters.
 */
export const DEMO_OUTCOMES = [
  'success',
  'transient_once',
  'rate_limited_once',
  'timeout_once',
  'partial_once',
  'permanent',
  'always_transient',
] as const;
export type DemoOutcome = (typeof DEMO_OUTCOMES)[number];

export const syntheticEventSchema = z.strictObject({
  eventId: z.string().regex(/^evt_[A-Za-z0-9]{8,64}$/),
  type: z.enum(EVENT_TYPES),
  occurredAt: z.iso.datetime({ offset: true }),
  source: z.literal('synthetic-demo'),
  data: z.strictObject({
    referenceId: z.string().regex(/^SYN-[0-9]{4,12}$/),
    amountMinor: z.number().int().min(0).max(1_000_000_000).optional(),
    currency: z.enum(['USD', 'EUR']).optional(),
    note: z.string().max(280).optional(),
    demoOutcome: z.enum(DEMO_OUTCOMES).optional(),
  }),
});

export type SyntheticEvent = z.infer<typeof syntheticEventSchema>;
