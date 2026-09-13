export interface RecordedAttempt {
  destination: string;
  runId: string;
  idempotencyKey?: string;
}

export interface RecordedEffect extends RecordedAttempt {
  target: unknown;
  payload: unknown;
}

const attempts: RecordedAttempt[] = [];
const effects: RecordedEffect[] = [];
const failuresRemaining = new Map<string, number>();
const targetFailuresRemaining = new Map<string, number>();
const completedDeliveries = new Set<string>();

export function resetRecordedDeliveries(): void {
  attempts.length = 0;
  effects.length = 0;
  failuresRemaining.clear();
  targetFailuresRemaining.clear();
  completedDeliveries.clear();
}

export function failNextDeliveries(destination: string, count: number): void {
  failuresRemaining.set(destination, count);
}

export function failNextDeliveriesTo(target: string, count: number): void {
  targetFailuresRemaining.set(target, count);
}

export function recordedAttempts(): readonly RecordedAttempt[] {
  return attempts;
}

export function recordedEffects(): readonly RecordedEffect[] {
  return effects;
}

export async function recordDelivery(effect: RecordedEffect): Promise<void> {
  attempts.push({
    destination: effect.destination,
    runId: effect.runId,
    ...(effect.idempotencyKey ? { idempotencyKey: effect.idempotencyKey } : {}),
  });

  const idempotencyKey = effect.idempotencyKey ?? `${effect.destination}:${effect.runId}`;
  if (completedDeliveries.has(idempotencyKey)) return;

  const remaining = failuresRemaining.get(effect.destination) ?? 0;
  if (remaining > 0) {
    failuresRemaining.set(effect.destination, remaining - 1);
    throw new Error(`${effect.destination} is temporarily unavailable`);
  }

  const target =
    typeof effect.target === "object" && effect.target !== null && "to" in effect.target
      ? String(effect.target.to)
      : "";
  const targetRemaining = targetFailuresRemaining.get(target) ?? 0;
  if (targetRemaining > 0) {
    targetFailuresRemaining.set(target, targetRemaining - 1);
    throw new Error(`${effect.destination} is temporarily unavailable for ${target}`);
  }

  completedDeliveries.add(idempotencyKey);
  effects.push(effect);
}
