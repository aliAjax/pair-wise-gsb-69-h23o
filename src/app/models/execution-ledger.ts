import { DeviationRecord } from './change-request.model';

export type ExecutionSource = 'console' | 'datacenter';
export type EventConfirmation =
  'unconfirmed' | 'confirmed' | 'conflict' | 'invalidated' | 'superseded';
export type EventWriteState = 'pending' | 'written' | 'failed';
export type ExecutionEventType =
  | 'execution-started'
  | 'step-completed'
  | 'step-reopened'
  | 'deviation-recorded'
  | 'execution-completed'
  | 'execution-rollback'
  | 'basis-invalidated'
  | 'event-reconfirmed'
  | 'conflict-resolved';

export interface PlanBasis {
  revision: number;
  windowHash: string;
  resourceHash: string;
  stepHash: string;
  changedAt: string;
}

export interface ExecutionEvent {
  id: string;
  changeId: string;
  changeVersion: number;
  source: ExecutionSource;
  occurredAt: string;
  receivedAt: string;
  type: ExecutionEventType;
  status: EventConfirmation;
  stepId?: string;
  stepNo?: number;
  stepTitle?: string;
  stepSnapshot?: unknown;
  payload: Record<string, unknown>;
  deviation?: DeviationRecord;
  matchedEventId?: string;
  conflictId?: string;
  reconciledAt?: string;
  invalidatedAt?: string;
  reconfirmedAt?: string;
  resolvedAt?: string;
  writeState?: EventWriteState;
  lastWriteError?: string;
}

export interface LedgerConflict {
  id: string;
  eventIds: [string, string];
  reason: string;
  status: 'pending' | 'resolved';
  winnerEventId?: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface ExecutionLedger {
  changeId: string;
  basis: PlanBasis;
  events: ExecutionEvent[];
  conflicts: LedgerConflict[];
  lastReconciledAt?: string;
}

export const EXECUTION_SOURCE_LABELS: Record<ExecutionSource, string> = {
  console: '控制台',
  datacenter: '机房值守',
};

export const EXECUTION_EVENT_LABELS: Record<ExecutionEventType, string> = {
  'execution-started': '开始执行',
  'step-completed': '步骤完成',
  'step-reopened': '步骤重开',
  'deviation-recorded': '执行偏离',
  'execution-completed': '执行完成',
  'execution-rollback': '执行回滚',
  'basis-invalidated': '依据变更失效',
  'event-reconfirmed': '重新确认',
  'conflict-resolved': '冲突复核结论',
};

export const EVENT_CONFIRMATION_LABELS: Record<EventConfirmation, string> = {
  unconfirmed: '待对账',
  confirmed: '已确认',
  conflict: '冲突待复核',
  invalidated: '依据变更已失效',
  superseded: '复核未采纳',
};

const STEP_PHASE_ORDER = ['prepare', 'execute', 'verify', 'rollback'] as const;

export function orderedStepIndexes(
  steps: Array<{ id: string; phase: string }>,
): Map<string, number> {
  const ordered = [...steps].sort(
    (left, right) =>
      STEP_PHASE_ORDER.indexOf(left.phase as (typeof STEP_PHASE_ORDER)[number]) -
        STEP_PHASE_ORDER.indexOf(right.phase as (typeof STEP_PHASE_ORDER)[number]) ||
      left.id.localeCompare(right.id),
  );
  return new Map(ordered.map((step, index) => [step.id, index + 1]));
}

export function createEventId(prefix = 'evt'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function createPlanBasis(
  change: {
    window: unknown;
    resources: unknown;
    steps: Array<{ completed?: boolean; completedAt?: string }>;
  },
  revision: number,
  changedAt = new Date().toISOString(),
): PlanBasis {
  const steps = change.steps.map(
    ({ completed: _completed, completedAt: _completedAt, ...step }) => step,
  );
  return {
    revision,
    windowHash: hashValue(change.window),
    resourceHash: hashValue(change.resources),
    stepHash: hashValue(steps),
    changedAt,
  };
}

export function createExecutionLedger(change: {
  id: string;
  window: unknown;
  resources: unknown;
  steps: Array<{ completed?: boolean; completedAt?: string }>;
}): ExecutionLedger {
  return {
    changeId: change.id,
    basis: createPlanBasis(change, 1),
    events: [],
    conflicts: [],
  };
}

export function createExecutionEvent(input: {
  changeId: string;
  changeVersion: number;
  source: ExecutionSource;
  type: ExecutionEventType;
  occurredAt?: string;
  status?: EventConfirmation;
  stepId?: string;
  stepNo?: number;
  stepTitle?: string;
  stepSnapshot?: unknown;
  payload?: Record<string, unknown>;
  deviation?: DeviationRecord;
  writeState?: EventWriteState;
}): ExecutionEvent {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  return {
    id: createEventId(),
    changeId: input.changeId,
    changeVersion: input.changeVersion,
    source: input.source,
    occurredAt,
    receivedAt: new Date().toISOString(),
    type: input.type,
    status: input.status ?? 'unconfirmed',
    stepId: input.stepId,
    stepNo: input.stepNo,
    stepTitle: input.stepTitle,
    stepSnapshot: input.stepSnapshot,
    payload: input.payload ?? {},
    deviation: input.deviation,
    writeState: input.writeState ?? 'pending',
  };
}

export function isOpenEvent(event: ExecutionEvent): boolean {
  return (
    event.status === 'unconfirmed' || event.status === 'conflict' || event.status === 'invalidated'
  );
}

export function isOperationalEvent(event: ExecutionEvent): boolean {
  return [
    'step-completed',
    'step-reopened',
    'deviation-recorded',
    'execution-completed',
    'execution-rollback',
  ].includes(event.type);
}

export function isTerminalEvent(
  type: ExecutionEventType,
): type is 'execution-completed' | 'execution-rollback' {
  return type === 'execution-completed' || type === 'execution-rollback';
}

export function isStepActionEvent(
  type: ExecutionEventType,
): type is 'step-completed' | 'step-reopened' {
  return type === 'step-completed' || type === 'step-reopened';
}

export function appendLedgerEvent(ledger: ExecutionLedger, event: ExecutionEvent): ExecutionLedger {
  if (ledger.events.some((item) => item.id === event.id)) {
    return ledger;
  }
  return {
    ...ledger,
    events: [...ledger.events, event].sort(compareEvents),
  };
}

export function reconcileExecutionLedger(
  ledger: ExecutionLedger,
  at = new Date().toISOString(),
  toleranceMs = 5_000,
): ExecutionLedger {
  const events = ledger.events.map((event) => ({ ...event }));
  const conflicts = [...ledger.conflicts];
  const byId = new Map(events.map((event) => [event.id, event]));
  const paired = new Set<string>();
  const operational = events
    .filter((event) => isOperationalEvent(event) && event.status === 'unconfirmed')
    .sort(compareEvents);

  for (const event of operational) {
    if (paired.has(event.id)) {
      continue;
    }
    const peer = operational.find((candidate) => {
      if (paired.has(candidate.id) || candidate.id === event.id) {
        return false;
      }
      return (
        candidate.source !== event.source &&
        candidate.changeVersion === event.changeVersion &&
        candidate.stepId === event.stepId &&
        candidate.stepNo === event.stepNo &&
        (candidate.type === event.type ||
          (isTerminalEvent(event.type) && isTerminalEvent(candidate.type)) ||
          (isStepActionEvent(event.type) && isStepActionEvent(candidate.type))) &&
        Math.abs(new Date(candidate.occurredAt).getTime() - new Date(event.occurredAt).getTime()) <=
          toleranceMs
      );
    });

    if (!peer) {
      continue;
    }

    paired.add(event.id);
    paired.add(peer.id);
    const samePayload = hashValue(event.payload) === hashValue(peer.payload);

    if (samePayload) {
      event.status = 'confirmed';
      peer.status = 'confirmed';
      event.matchedEventId = peer.id;
      peer.matchedEventId = event.id;
      event.reconciledAt = at;
      peer.reconciledAt = at;
    } else {
      const conflictId = `conflict-${event.id}-${peer.id}`;
      if (!conflicts.some((conflict) => conflict.id === conflictId)) {
        conflicts.push({
          id: conflictId,
          eventIds: [event.id, peer.id],
          reason: conflictReason(event.type),
          status: 'pending',
        });
      }
      for (const item of [event, peer]) {
        item.status = 'conflict';
        item.conflictId = conflictId;
        item.matchedEventId = item === event ? peer.id : event.id;
        item.reconciledAt = at;
      }
    }
  }

  return {
    ...ledger,
    events: events.sort(compareEvents),
    conflicts,
    lastReconciledAt: at,
  };
}

export function resolveLedgerConflict(
  ledger: ExecutionLedger,
  winnerEventId: string,
  resolutionNote: string,
  at = new Date().toISOString(),
): ExecutionLedger {
  const conflict = ledger.conflicts.find(
    (item) => item.status === 'pending' && item.eventIds.includes(winnerEventId),
  );
  const winner = ledger.events.find((event) => event.id === winnerEventId);
  if (!conflict || !winner) {
    return ledger;
  }

  const events = ledger.events.map((event) => {
    if (!conflict.eventIds.includes(event.id)) {
      return event;
    }
    if (event.id === winnerEventId) {
      return {
        ...event,
        status: 'confirmed' as const,
        resolvedAt: at,
        conflictId: conflict.id,
      };
    }
    return {
      ...event,
      status: 'superseded' as const,
      resolvedAt: at,
      conflictId: conflict.id,
    };
  });
  const resolution = createExecutionEvent({
    changeId: ledger.changeId,
    changeVersion: ledger.basis.revision,
    source: winner.source,
    type: 'conflict-resolved',
    occurredAt: at,
    status: 'confirmed',
    writeState: 'pending',
    payload: {
      conflictId: conflict.id,
      winnerEventId,
      note: resolutionNote,
    },
  });

  return {
    ...ledger,
    events: [...events, resolution].sort(compareEvents),
    conflicts: ledger.conflicts.map((item) =>
      item.id === conflict.id
        ? {
            ...item,
            status: 'resolved',
            winnerEventId,
            resolvedAt: at,
            resolutionNote,
          }
        : item,
    ),
  };
}

export function reconfirmLedgerEvent(
  ledger: ExecutionLedger,
  eventId: string,
  at = new Date().toISOString(),
): ExecutionLedger {
  const target = ledger.events.find(
    (event) => event.id === eventId && event.status === 'invalidated',
  );
  if (!target) {
    return ledger;
  }

  const conflict =
    target.conflictId &&
    ledger.conflicts.find((item) => item.id === target.conflictId && item.status === 'pending');
  const events = ledger.events.map((event) => {
    if (conflict && conflict.eventIds.includes(event.id)) {
      return {
        ...event,
        status: event.id === eventId ? ('confirmed' as const) : ('superseded' as const),
        reconfirmedAt: event.id === eventId ? at : undefined,
        invalidatedAt: undefined,
        resolvedAt: at,
      };
    }
    return event.id === eventId
      ? {
          ...event,
          status: 'confirmed' as const,
          reconfirmedAt: at,
          invalidatedAt: undefined,
        }
      : event;
  });
  const confirmation = createExecutionEvent({
    changeId: ledger.changeId,
    changeVersion: ledger.basis.revision,
    source: target.source,
    type: conflict ? 'conflict-resolved' : 'event-reconfirmed',
    occurredAt: at,
    status: 'confirmed',
    writeState: 'pending',
    payload: conflict
      ? {
          conflictId: conflict.id,
          winnerEventId: eventId,
          note: '窗口或资源依赖变化后重新复核，采纳该事件。',
        }
      : {
          originalEventId: target.id,
          originalChangeVersion: target.changeVersion,
        },
  });

  return {
    ...ledger,
    events: [...events, confirmation].sort(compareEvents),
    conflicts: conflict
      ? ledger.conflicts.map((item) =>
          item.id === conflict.id
            ? {
                ...item,
                status: 'resolved',
                winnerEventId: eventId,
                resolvedAt: at,
                resolutionNote: '依据新版本重新确认后采纳。',
              }
            : item,
        )
      : ledger.conflicts,
  };
}

export function basisChanged(previous: PlanBasis, next: PlanBasis): boolean {
  return (
    previous.windowHash !== next.windowHash ||
    previous.resourceHash !== next.resourceHash ||
    previous.stepHash !== next.stepHash
  );
}

export function invalidateUnconfirmedEvents(
  ledger: ExecutionLedger,
  nextBasis: PlanBasis,
  at = new Date().toISOString(),
): ExecutionLedger {
  if (!basisChanged(ledger.basis, nextBasis)) {
    return { ...ledger, basis: nextBasis };
  }

  const events = ledger.events.map((event) =>
    event.status === 'unconfirmed' || event.status === 'conflict'
      ? {
          ...event,
          status: 'invalidated' as const,
          invalidatedAt: at,
        }
      : event,
  );
  const invalidation = createExecutionEvent({
    changeId: ledger.changeId,
    changeVersion: nextBasis.revision,
    source: 'console',
    type: 'basis-invalidated',
    occurredAt: at,
    status: 'confirmed',
    writeState: 'pending',
    payload: {
      previousRevision: ledger.basis.revision,
      currentRevision: nextBasis.revision,
    },
  });

  return {
    ...ledger,
    basis: nextBasis,
    events: [...events, invalidation].sort(compareEvents),
  };
}

export function getStepNumber(
  steps: Array<{ id: string; phase: string }>,
  stepId: string,
): number | undefined {
  return orderedStepIndexes(steps).get(stepId);
}

function compareEvents(left: ExecutionEvent, right: ExecutionEvent): number {
  return (
    new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime() ||
    left.id.localeCompare(right.id)
  );
}

function conflictReason(type: ExecutionEventType): string {
  switch (type) {
    case 'step-completed':
    case 'step-reopened':
      return '两端对同一步骤提交了不同完成状态';
    case 'deviation-recorded':
      return '两端记录的偏离事实或处置决定不一致';
    case 'execution-completed':
    case 'execution-rollback':
      return '两端最终结论不一致';
    default:
      return '两端事件内容不一致';
  }
}

function hashValue(value: unknown): string {
  const text = stableStringify(value);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
