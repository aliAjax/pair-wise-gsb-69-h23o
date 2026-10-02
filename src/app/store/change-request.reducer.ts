import { createReducer, on } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  APPROVAL_ORDER,
  createAudit,
} from '../models/change-request.model';
import {
  ExecutionEvent,
  ExecutionLedger,
  ExecutionSource,
  appendLedgerEvent,
  basisChanged,
  createExecutionEvent,
  createExecutionLedger,
  createPlanBasis,
  getStepNumber,
  invalidateUnconfirmedEvents,
  reconcileExecutionLedger,
  reconfirmLedgerEvent,
  resolveLedgerConflict,
} from '../models/execution-ledger';
import { materializeProjectedChange, projectExecution } from '../models/execution-projection';
import { ChangeRequestActions } from './change-request.actions';

export interface ChangeRequestState {
  changes: ChangeRequest[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  lastSavedAt: string | null;
}

export const initialChangeRequestState: ChangeRequestState = {
  changes: [],
  loading: false,
  saving: false,
  error: null,
  lastSavedAt: null,
};

function touch(change: ChangeRequest): ChangeRequest {
  return { ...change, updatedAt: new Date().toISOString() };
}

function nextPendingStage(change: ChangeRequest): ApprovalStage | null {
  return (
    APPROVAL_ORDER.find((stage) =>
      change.approvals.some((approval) => approval.stage === stage && approval.state === 'pending'),
    ) ?? null
  );
}

function normalizeChange(change: ChangeRequest): ChangeRequest {
  if (
    change.executionLedger ||
    !['executing', 'completed', 'rolled_back'].includes(change.status)
  ) {
    return change;
  }
  const ledger = migrateExecutionLedger(change);
  return { ...materializeProjectedChange(change, ledger), executionLedger: ledger };
}

function migrateExecutionLedger(change: ChangeRequest): ExecutionLedger {
  const ledger = createExecutionLedger(change);
  const now = new Date().toISOString();
  ledger.events.push(
    createExecutionEvent({
      changeId: change.id,
      changeVersion: 1,
      source: 'console',
      type: 'execution-started',
      occurredAt: change.status === 'executing' ? change.updatedAt : change.createdAt,
      status: 'confirmed',
      writeState: 'written',
    }),
  );

  change.steps
    .filter((step) => step.completed)
    .forEach((step) => {
      ledger.events.push(
        createExecutionEvent({
          changeId: change.id,
          changeVersion: 1,
          source: 'console',
          type: 'step-completed',
          occurredAt: step.completedAt ?? change.updatedAt,
          status: 'confirmed',
          stepId: step.id,
          stepNo: getStepNumber(change.steps, step.id),
          stepTitle: step.title,
          stepSnapshot: step,
          payload: { completedAt: step.completedAt ?? change.updatedAt },
          writeState: 'written',
        }),
      );
    });

  change.deviations.forEach((deviation) => {
    ledger.events.push(
      createExecutionEvent({
        changeId: change.id,
        changeVersion: 1,
        source: 'datacenter',
        type: 'deviation-recorded',
        occurredAt: deviation.recordedAt,
        status: 'confirmed',
        payload: {
          description: deviation.description,
          decision: deviation.decision,
          owner: deviation.owner,
        },
        deviation,
        writeState: 'written',
      }),
    );
  });

  if (change.status === 'completed' || change.status === 'rolled_back') {
    ledger.events.push(
      createExecutionEvent({
        changeId: change.id,
        changeVersion: 1,
        source: 'console',
        type: change.status === 'completed' ? 'execution-completed' : 'execution-rollback',
        occurredAt: change.updatedAt,
        status: 'confirmed',
        payload: { note: change.audit[0]?.detail ?? '由历史审计记录还原最终结论。' },
        writeState: 'written',
      }),
    );
  }

  ledger.events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  ledger.lastReconciledAt = now;
  return ledger;
}

function withLedger(
  change: ChangeRequest,
  ledger: ExecutionLedger | undefined,
  addAudit?: (projected: ChangeRequest) => ChangeRequest['audit'],
): ChangeRequest {
  if (!ledger) {
    return touch(change);
  }
  const before = projectExecution(change, change.executionLedger);
  const projected = materializeProjectedChange({ ...change, executionLedger: ledger }, ledger);
  let audit = projected.audit;
  if (before.status !== projected.status) {
    audit = [
      createAudit(
        projected.status === 'completed' ? '执行完成' : '执行回滚',
        projected.status === 'completed'
          ? '两端对账完成，合并账本判定变更完成。'
          : '两端对账完成，合并账本判定变更回滚。',
      ),
      ...audit,
    ];
  }
  if (addAudit) {
    audit = addAudit({ ...projected, audit });
  }
  return touch({ ...projected, audit });
}

function updateBasisAfterPlanChange(change: ChangeRequest, incoming: ChangeRequest): ChangeRequest {
  if (!change.executionLedger) {
    return incoming;
  }

  const currentBasis = change.executionLedger.basis;
  const nextBasis = createPlanBasis(incoming, currentBasis.revision + 1);
  if (!basisChanged(currentBasis, nextBasis)) {
    return incoming;
  }

  const ledger = invalidateUnconfirmedEvents(change.executionLedger, nextBasis);
  return withLedger(
    {
      ...incoming,
      approvals: change.approvals,
      executionLedger: ledger,
    },
    ledger,
    (projected) => [
      createAudit(
        '执行依据变更',
        `窗口或资源依赖已更新到版本 ${nextBasis.revision}，未确认事件已失效，可重新确认；已成立操作继续保留。`,
      ),
      ...projected.audit,
    ],
  );
}

function stepEvent(
  change: ChangeRequest,
  stepId: string,
  source: ExecutionSource,
  occurredAt: string | undefined,
  oppositeToEventId?: string,
): { ledger: ExecutionLedger; event: ExecutionEvent } | null {
  const ledger = change.executionLedger;
  const step = change.steps.find((item) => item.id === stepId);
  const projected = projectExecution(change, ledger);
  if (!ledger || !step || projected.status !== 'executing') {
    return null;
  }

  const target = projected.steps.find((item) => item.id === stepId);
  const oppositeEvent = oppositeToEventId
    ? ledger.events.find(
        (event) =>
          event.id === oppositeToEventId &&
          (event.type === 'step-completed' || event.type === 'step-reopened'),
      )
    : undefined;
  const type: 'step-completed' | 'step-reopened' = oppositeEvent
    ? oppositeEvent.type === 'step-completed'
      ? 'step-reopened'
      : 'step-completed'
    : target?.completed
      ? 'step-reopened'
      : 'step-completed';
  const hasOpenSameSource = ledger.events.some(
    (event) =>
      event.stepId === stepId &&
      event.source === source &&
      ['unconfirmed', 'conflict'].includes(event.status) &&
      isOperationalStepEvent(event),
  );
  const hasUnrelatedOpenEvent = ledger.events.some(
    (event) =>
      event.stepId === stepId &&
      event.source !== source &&
      (!oppositeEvent || event.id !== oppositeEvent.id) &&
      event.type !== type &&
      !['step-completed', 'step-reopened'].includes(event.type) &&
      ['unconfirmed', 'conflict', 'invalidated'].includes(event.status),
  );
  if (hasOpenSameSource || hasUnrelatedOpenEvent) {
    return null;
  }

  const at = occurredAt ?? new Date().toISOString();
  const event = createExecutionEvent({
    changeId: change.id,
    changeVersion: ledger.basis.revision,
    source,
    type,
    occurredAt: at,
    stepId,
    stepNo: getStepNumber(change.steps, stepId),
    stepTitle: step.title,
    stepSnapshot: step,
    payload:
      type === 'step-completed' ? { completedAt: at, owner: step.owner } : { owner: step.owner },
  });
  return { ledger: appendLedgerEvent(ledger, event), event };
}

function isOperationalStepEvent(event: ExecutionEvent): boolean {
  return event.type === 'step-completed' || event.type === 'step-reopened';
}

function terminalResultOf(
  type: 'execution-completed' | 'execution-rollback',
): 'completed' | 'rolled_back' {
  return type === 'execution-completed' ? 'completed' : 'rolled_back';
}

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { changes }) => ({
    ...state,
    changes: changes.map(normalizeChange),
    loading: false,
  })),
  on(ChangeRequestActions.loadChangesFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(ChangeRequestActions.createChange, (state, { change }) => ({
    ...state,
    saving: true,
    error: null,
    changes: [
      {
        ...change,
        audit: [createAudit('创建草稿', `创建变更 ${change.id}`), ...change.audit],
      },
      ...state.changes,
    ],
  })),
  on(ChangeRequestActions.updateChange, (state, { change }) => ({
    ...state,
    saving: true,
    error: null,
    changes: state.changes.map((item) => {
      if (item.id !== change.id) {
        return item;
      }
      const restored = change.executionLedger
        ? materializeProjectedChange(change, change.executionLedger)
        : change;
      const updated = item.executionLedger
        ? updateBasisAfterPlanChange(item, {
            ...restored,
            approvals: item.approvals,
          })
        : touch({
            ...restored,
            audit: [createAudit('保存变更方案', '更新资源、步骤或窗口信息'), ...restored.audit],
          });
      return updated;
    }),
  })),
  on(ChangeRequestActions.deleteDraft, (state, { id }) => ({
    ...state,
    saving: true,
    changes: state.changes.filter((change) => change.id !== id || change.status !== 'draft'),
  })),
  on(ChangeRequestActions.submitForReview, (state, { id }) => ({
    ...state,
    saving: true,
    changes: state.changes.map((change) =>
      change.id === id && ['draft', 'rejected'].includes(change.status)
        ? touch({
            ...change,
            status: 'submitted',
            approvals: change.approvals.map((approval) => ({ ...approval, state: 'pending' })),
            audit: [
              createAudit('提交审批', '方案冻结后进入网络、系统、安全、业务顺序会签'),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.approveStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    saving: true,
    changes: state.changes.map((change) => {
      if (change.id !== id || nextPendingStage(change) !== stage) {
        return change;
      }

      const approvals = change.approvals.map((approval) =>
        approval.stage === stage
          ? {
              ...approval,
              state: 'approved' as const,
              approver,
              comment,
              decidedAt: new Date().toISOString(),
            }
          : approval,
      );
      const allApproved = approvals.every((approval) => approval.state === 'approved');

      return touch({
        ...change,
        status: allApproved ? 'approved' : 'submitted',
        approvals,
        audit: [
          createAudit('阶段会签', `${stage} 已由 ${approver} 批准：${comment}`),
          ...change.audit,
        ],
      });
    }),
  })),
  on(ChangeRequestActions.rejectStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    saving: true,
    changes: state.changes.map((change) =>
      change.id === id
        ? touch({
            ...change,
            status: 'rejected',
            approvals: change.approvals.map((approval) =>
              approval.stage === stage
                ? {
                    ...approval,
                    state: 'rejected',
                    approver,
                    comment,
                    decidedAt: new Date().toISOString(),
                  }
                : approval,
            ),
            audit: [
              createAudit('审批退回', `${stage} 由 ${approver} 退回：${comment}`),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.startExecution, (state, { id, source }) => ({
    ...state,
    saving: true,
    changes: state.changes.map((change) => {
      if (change.id !== id || change.status !== 'approved' || change.executionLedger) {
        return change;
      }
      let ledger = createExecutionLedger(change);
      const event = createExecutionEvent({
        changeId: change.id,
        changeVersion: ledger.basis.revision,
        source,
        type: 'execution-started',
        status: 'confirmed',
      });
      ledger = appendLedgerEvent(ledger, event);
      return withLedger(
        {
          ...change,
          status: 'executing',
          approvals: change.approvals.map((approval) => ({ ...approval, state: 'frozen' })),
          executionLedger: ledger,
        },
        ledger,
        (projected) => [
          createAudit('开始执行', '审批记录已冻结，事件账本开始记录'),
          ...projected.audit,
        ],
      );
    }),
  })),
  on(
    ChangeRequestActions.toggleStep,
    (state, { id, stepId, source, occurredAt, oppositeToEventId }) => ({
      ...state,
      saving: true,
      changes: state.changes.map((change) => {
        if (change.id !== id) {
          return change;
        }
        const result = stepEvent(change, stepId, source, occurredAt, oppositeToEventId);
        return result ? withLedger(change, result.ledger) : change;
      }),
    }),
  ),
  on(ChangeRequestActions.recordDeviation, (state, { id, deviation, source }) => ({
    ...state,
    saving: true,
    changes: state.changes.map((change) => {
      if (change.id !== id || !change.executionLedger) {
        return change;
      }
      const projected = projectExecution(change, change.executionLedger);
      if (projected.status !== 'executing') {
        return change;
      }
      const event = createExecutionEvent({
        changeId: change.id,
        changeVersion: change.executionLedger.basis.revision,
        source,
        type: 'deviation-recorded',
        occurredAt: deviation.recordedAt,
        payload: {
          description: deviation.description,
          decision: deviation.decision,
          owner: deviation.owner,
        },
        deviation,
      });
      const ledger = appendLedgerEvent(change.executionLedger, event);
      return withLedger(change, ledger);
    }),
  })),
  on(ChangeRequestActions.reconcileLedger, (state, { id }) => ({
    ...state,
    saving: true,
    changes: state.changes.map((change) => {
      if (change.id !== id || !change.executionLedger) {
        return change;
      }
      const ledger = reconcileExecutionLedger(change.executionLedger);
      return withLedger(change, ledger, (projected) => [
        createAudit('账本对账', '按变更版本、步骤编号和发生时间合并两端事件；冲突保持待复核。'),
        ...projected.audit,
      ]);
    }),
  })),
  on(ChangeRequestActions.resolveLedgerConflict, (state, { id, eventId, note }) => ({
    ...state,
    saving: true,
    changes: state.changes.map((change) => {
      if (change.id !== id || !change.executionLedger) {
        return change;
      }
      const ledger = resolveLedgerConflict(change.executionLedger, eventId, note);
      return withLedger(change, ledger, (projected) => [
        createAudit('冲突复核', `采纳事件 ${eventId}：${note}`),
        ...projected.audit,
      ]);
    }),
  })),
  on(ChangeRequestActions.reconfirmLedgerEvent, (state, { id, eventId }) => ({
    ...state,
    saving: true,
    changes: state.changes.map((change) => {
      if (change.id !== id || !change.executionLedger) {
        return change;
      }
      const ledger = reconfirmLedgerEvent(change.executionLedger, eventId);
      return withLedger(change, ledger, (projected) => [
        createAudit('事件重新确认', `依据新版本重新确认事件 ${eventId}。`),
        ...projected.audit,
      ]);
    }),
  })),
  on(ChangeRequestActions.completeExecution, (state, { id, result, note, source, occurredAt }) => ({
    ...state,
    saving: true,
    changes: state.changes.map((change) => {
      if (change.id !== id || !change.executionLedger) {
        return change;
      }
      const ledgerBeforeAppend = change.executionLedger;
      const projection = projectExecution(change, ledgerBeforeAppend);
      const allStepsCompleted =
        projection.steps.length > 0 &&
        projection.steps
          .filter((step) => step.phase !== 'rollback')
          .every((step) => step.completed);
      const openTerminal = ledgerBeforeAppend.events.find(
        (
          event,
        ): event is ExecutionEvent & {
          type: 'execution-completed' | 'execution-rollback';
        } =>
          event.status === 'unconfirmed' &&
          (event.type === 'execution-completed' || event.type === 'execution-rollback'),
      );
      const counterpartTerminal =
        openTerminal &&
        openTerminal.source !== source &&
        projection.openConflictCount === 0 &&
        projection.invalidatedCount === 0 &&
        projection.unconfirmedCount === 1
          ? openTerminal
          : undefined;

      if (!counterpartTerminal) {
        if (
          projection.status !== 'executing' ||
          projection.openConflictCount > 0 ||
          projection.invalidatedCount > 0 ||
          projection.unconfirmedCount > 0 ||
          (result === 'completed' && !allStepsCompleted)
        ) {
          return change;
        }
      }

      const event = createExecutionEvent({
        changeId: change.id,
        changeVersion: ledgerBeforeAppend.basis.revision,
        source,
        type: result === 'completed' ? 'execution-completed' : 'execution-rollback',
        occurredAt: occurredAt ?? counterpartTerminal?.occurredAt,
        payload:
          counterpartTerminal && result === terminalResultOf(counterpartTerminal.type)
            ? counterpartTerminal.payload
            : { note },
      });
      const appended = appendLedgerEvent(ledgerBeforeAppend, event);
      const ledger = counterpartTerminal ? reconcileExecutionLedger(appended) : appended;
      return withLedger(change, ledger);
    }),
  })),
  on(ChangeRequestActions.saveChangesSuccess, (state) => ({
    ...state,
    saving: false,
    error: null,
    lastSavedAt: new Date().toISOString(),
    changes: state.changes.map((change) =>
      change.executionLedger
        ? {
            ...change,
            executionLedger: {
              ...change.executionLedger,
              events: change.executionLedger.events.map((event) =>
                event.writeState === 'pending' || event.writeState === 'failed'
                  ? { ...event, writeState: 'written', lastWriteError: undefined }
                  : event,
              ),
            },
          }
        : change,
    ),
  })),
  on(ChangeRequestActions.saveChangesFailure, (state, { error }) => ({
    ...state,
    saving: false,
    error,
    changes: state.changes.map((change) =>
      change.executionLedger
        ? {
            ...change,
            executionLedger: {
              ...change.executionLedger,
              events: change.executionLedger.events.map((event) =>
                event.writeState === 'pending'
                  ? { ...event, writeState: 'failed', lastWriteError: error }
                  : event,
              ),
            },
          }
        : change,
    ),
  })),
);
