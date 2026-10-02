import { ChangeRequest, ChangeStatus, ChangeStep, DeviationRecord } from './change-request.model';
import { ExecutionEvent, ExecutionLedger } from './execution-ledger';

export interface ProjectedExecution {
  status: ChangeStatus;
  steps: ChangeStep[];
  deviations: DeviationRecord[];
  terminalEvent?: ExecutionEvent;
  pendingStepEvents: Map<string, ExecutionEvent[]>;
  openConflictCount: number;
  invalidatedCount: number;
  unconfirmedCount: number;
}

export function projectExecution(
  change: ChangeRequest,
  ledger?: ExecutionLedger,
): ProjectedExecution {
  const steps = change.steps.map((step) => ({ ...step }));
  const deviations = change.deviations.map((deviation) => ({ ...deviation }));
  const pendingStepEvents = new Map<string, ExecutionEvent[]>();
  let status: ChangeStatus = change.status;
  let terminalEvent: ExecutionEvent | undefined;

  if (!ledger) {
    return {
      status,
      steps,
      deviations,
      pendingStepEvents,
      openConflictCount: 0,
      invalidatedCount: 0,
      unconfirmedCount: 0,
    };
  }

  const indexedSteps = new Map<string, ChangeStep>();
  steps.forEach((step) => indexedSteps.set(step.id, step));

  ledger.events
    .filter((event) => event.status === 'confirmed')
    .sort(
      (left, right) => new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime(),
    )
    .forEach((event) => {
      switch (event.type) {
        case 'execution-started':
          status = 'executing';
          break;
        case 'step-completed':
        case 'step-reopened': {
          const target = findStep(event, steps);
          if (target) {
            target.completed = event.type === 'step-completed';
            target.completedAt =
              event.type === 'step-completed'
                ? ((event.payload['completedAt'] as string | undefined) ?? event.occurredAt)
                : undefined;
          }
          break;
        }
        case 'deviation-recorded':
          if (event.deviation && !deviations.some((item) => item.id === event.deviation?.id)) {
            deviations.unshift(event.deviation);
          }
          break;
        case 'execution-completed':
        case 'execution-rollback':
          status = event.type === 'execution-completed' ? 'completed' : 'rolled_back';
          terminalEvent = event;
          break;
      }
    });

  ledger.events
    .filter(
      (event) =>
        event.stepId &&
        ['step-completed', 'step-reopened'].includes(event.type) &&
        event.status !== 'confirmed' &&
        event.status !== 'superseded',
    )
    .forEach((event) => {
      const list = pendingStepEvents.get(event.stepId!) ?? [];
      pendingStepEvents.set(event.stepId!, [...list, event]);
    });

  return {
    status,
    steps,
    deviations,
    terminalEvent,
    pendingStepEvents,
    openConflictCount: ledger.events.filter((event) => event.status === 'conflict').length,
    invalidatedCount: ledger.events.filter((event) => event.status === 'invalidated').length,
    unconfirmedCount: ledger.events.filter((event) => event.status === 'unconfirmed').length,
  };
}

export function materializeProjectedChange(
  change: ChangeRequest,
  ledger?: ExecutionLedger,
): ChangeRequest {
  const projected = projectExecution(change, ledger);
  return {
    ...change,
    status: projected.status,
    steps: projected.steps,
    deviations: projected.deviations,
  };
}

function findStep(event: ExecutionEvent, steps: ChangeStep[]): ChangeStep | undefined {
  if (event.stepId) {
    const byId = steps.find((step) => step.id === event.stepId);
    if (byId) {
      return byId;
    }
  }
  if (typeof event.stepNo === 'number') {
    return steps[event.stepNo - 1];
  }
  return undefined;
}
