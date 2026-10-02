import { createReducer, on } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  APPROVAL_ORDER,
  createAudit,
} from '../models/change-request.model';
import {
  ChangeLedger,
  ExecutionEvent,
  LedgerSiteId,
  LedgerWorkspace,
  createChangeLedger,
  createEmptyLedgerWorkspace,
  newEventId,
  projectLedger,
  reconcileIntoLedger,
} from '../models/execution-ledger.model';
import { ChangeRequestActions } from './change-request.actions';

export interface ChangeRequestState {
  changes: ChangeRequest[];
  workspace: LedgerWorkspace;
  loading: boolean;
  error: string | null;
}

export const initialChangeRequestState: ChangeRequestState = {
  changes: [],
  workspace: createEmptyLedgerWorkspace(),
  loading: false,
  error: null,
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

function mapLedger(
  workspace: LedgerWorkspace,
  changeId: string,
  fn: (ledger: ChangeLedger) => ChangeLedger,
): LedgerWorkspace {
  const ledger = workspace.ledgers[changeId];
  if (!ledger) {
    return workspace;
  }
  const next = fn(ledger);
  return { ...workspace, ledgers: { ...workspace.ledgers, [changeId]: next } };
}

/**
 * 从同一份合并账本把步骤、偏离和最终结论重放回变更视图。
 * 完成或回滚状态只能由这里推导，不能由单次操作直接写入。
 */
function applyLedgerProjection(changes: ChangeRequest[], ledger: ChangeLedger): ChangeRequest[] {
  const change = changes.find((item) => item.id === ledger.changeId);
  if (!change) {
    return changes;
  }

  const projection = projectLedger(ledger);
  const steps = change.steps.map((step) => {
    const state = projection.stepState[step.id];
    if (!state) {
      return step.completed ? { ...step, completed: false, completedAt: undefined } : step;
    }
    return {
      ...step,
      completed: state.done,
      completedAt: state.done ? state.at : undefined,
    };
  });

  let status = change.status;
  let audit = change.audit;
  if (projection.outcome && change.status === 'executing') {
    status = projection.outcome;
    audit = [
      createAudit(
        projection.outcome === 'completed' ? '执行完成' : '执行回滚',
        '最终结论由两端合并账本重放得出',
      ),
      ...audit,
    ];
  }

  return changes.map((item) =>
    item.id === change.id
      ? touch({ ...item, steps, deviations: projection.deviations, status, audit })
      : item,
  );
}

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { changes }) => ({
    ...state,
    changes,
    loading: false,
  })),
  on(ChangeRequestActions.loadChangesFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(ChangeRequestActions.loadLedgerWorkspaceSuccess, (state, { workspace }) => ({
    ...state,
    workspace,
  })),
  on(ChangeRequestActions.createChange, (state, { change }) => ({
    ...state,
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
    changes: state.changes.map((item) =>
      item.id === change.id
        ? touch({
            ...change,
            audit: [createAudit('保存变更方案', '更新资源、步骤或窗口信息'), ...change.audit],
          })
        : item,
    ),
  })),
  on(ChangeRequestActions.deleteDraft, (state, { id }) => ({
    ...state,
    changes: state.changes.filter((change) => change.id !== id || change.status !== 'draft'),
  })),
  on(ChangeRequestActions.submitForReview, (state, { id }) => ({
    ...state,
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
      const allApproved = approvals.every((approval) =>
        approval.stage === stage ? true : approval.state === 'approved',
      );

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

  // 开始执行：建立两端共用的事件账本，审批内容照旧冻结。
  on(ChangeRequestActions.startExecution, (state, { id }) => {
    const change = state.changes.find((item) => item.id === id);
    if (!change || change.status !== 'approved') {
      return state;
    }
    const now = new Date().toISOString();
    const ledger = state.workspace.ledgers[id] ?? createChangeLedger(id, now);
    return {
      ...state,
      changes: state.changes.map((item) =>
        item.id === id
          ? touch({
              ...item,
              status: 'executing',
              approvals: item.approvals.map((approval) => ({ ...approval, state: 'frozen' })),
              audit: [createAudit('开始执行', '审批记录已冻结，双端事件账本建立'), ...item.audit],
            })
          : item,
      ),
      workspace: {
        ...state.workspace,
        ledgers: { ...state.workspace.ledgers, [id]: ledger },
      },
    };
  }),

  on(ChangeRequestActions.switchSite, (state, { site }) => ({
    ...state,
    workspace: { ...state.workspace, currentSite: site },
  })),
  on(ChangeRequestActions.setSiteOnline, (state, { site, online }) => ({
    ...state,
    workspace: {
      ...state.workspace,
      online: { ...state.workspace.online, [site]: online },
    },
  })),
  on(ChangeRequestActions.toggleFailureInjection, (state, { enabled }) => ({
    ...state,
    workspace: { ...state.workspace, injectFailure: enabled },
  })),

  // 事件先进入发件箱，状态为未确认；写入失败可重试，成功后才参与对账。
  on(ChangeRequestActions.ledgerEventSubmitted, (state, { event }) => ({
    ...state,
    workspace: mapLedger(state.workspace, event.changeId, (ledger) => {
      if (ledger.events.some((item) => item.id === event.id)) {
        return ledger;
      }
      const now = new Date().toISOString();
      return {
        ...ledger,
        events: [...ledger.events, { ...event, status: 'pending' as const }],
        outbox: [
          ...ledger.outbox,
          {
            eventId: event.id,
            site: event.site,
            state: 'queued' as const,
            attempts: 0,
            lastError: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    }),
  })),

  on(ChangeRequestActions.ledgerEventDeliveryFailed, (state, { eventId, error }) => ({
    ...state,
    workspace: {
      ...state.workspace,
      ledgers: Object.fromEntries(
        Object.entries(state.workspace.ledgers).map(([changeId, ledger]) => [
          changeId,
          ledger.outbox.some((entry) => entry.eventId === eventId)
            ? {
                ...ledger,
                outbox: ledger.outbox.map((entry) =>
                  entry.eventId === eventId && entry.state !== 'delivered'
                    ? {
                        ...entry,
                        state: 'failed' as const,
                        attempts: entry.attempts + 1,
                        lastError: error,
                        updatedAt: new Date().toISOString(),
                      }
                    : entry,
                ),
              }
            : ledger,
        ]),
      ),
    },
  })),

  // 并入合并账本：幂等去重，键同载荷异则挂冲突；随后重放执行态。
  on(ChangeRequestActions.ledgerEventDelivered, (state, { event }) => {
    const ledger = state.workspace.ledgers[event.changeId];
    if (!ledger) {
      return state;
    }
    const now = new Date().toISOString();
    const reconciled = reconcileIntoLedger(ledger, {
      ...event,
      submittedAt:
        ledger.events.find((item) => item.id === event.id)?.submittedAt ?? event.submittedAt,
    });
    const nextLedger: ChangeLedger = {
      ...reconciled,
      outbox: reconciled.outbox.map((entry) =>
        entry.eventId === event.id
          ? {
              ...entry,
              state: 'delivered' as const,
              attempts: entry.attempts + 1,
              lastError: null,
              updatedAt: now,
            }
          : entry,
      ),
      lastRebuiltAt: now,
    };
    return {
      ...state,
      workspace: {
        ...state.workspace,
        ledgers: { ...state.workspace.ledgers, [event.changeId]: nextLedger },
      },
      changes: applyLedgerProjection(state.changes, nextLedger),
    };
  }),

  // 窗口或资源依赖变化：版本/纪元递增；未确认事件先失效，已确认事件不受影响。
  on(ChangeRequestActions.registerContextChange, (state, { id, note }) => {
    let nextLedger: ChangeLedger | null = null;
    const workspace = mapLedger(state.workspace, id, (ledger) => {
      const now = new Date().toISOString();
      const version = ledger.version + 1;
      const epoch = ledger.epoch + 1;
      const contextEvent: ExecutionEvent = {
        id: newEventId('ctx'),
        changeId: id,
        version,
        epoch,
        type: 'context',
        occurredAt: now,
        site: state.workspace.currentSite,
        actor: '当前用户',
        note,
        status: 'committed',
        submittedAt: now,
      };
      nextLedger = {
        ...ledger,
        version,
        epoch,
        seq: ledger.seq + 1,
        events: [
          ...ledger.events.map((event) =>
            event.status === 'pending' ? { ...event, status: 'invalidated' as const } : event,
          ),
          contextEvent,
        ],
        outbox: ledger.outbox.map((entry) =>
          entry.state === 'queued' || entry.state === 'failed'
            ? { ...entry, state: 'superseded' as const, updatedAt: now }
            : entry,
        ),
        lastRebuiltAt: now,
      };
      return nextLedger;
    });

    if (!nextLedger) {
      return state;
    }

    return {
      ...state,
      workspace,
      changes: state.changes.map((change) =>
        change.id === id
          ? touch({
              ...change,
              audit: [
                createAudit(
                  '窗口/依赖变化',
                  `变更版本升至 v${nextLedger!.version}：${note}；未确认事件已失效待重新确认`,
                ),
                ...change.audit,
              ],
            })
          : change,
      ),
    };
  }),

  // 冲突复核：采纳其中一方或双方均舍弃，复核后再重放。
  on(
    ChangeRequestActions.resolveConflict,
    (state, { changeId, conflictId, resolution, acceptedEventId, reviewer }) => {
      const ledger = state.workspace.ledgers[changeId];
      const conflict = ledger?.conflicts.find((item) => item.id === conflictId);
      if (!ledger || !conflict || conflict.status === 'resolved') {
        return state;
      }
      const now = new Date().toISOString();
      const accepted = new Set(resolution === 'accept' && acceptedEventId ? [acceptedEventId] : []);
      const nextLedger: ChangeLedger = {
        ...ledger,
        events: ledger.events.map((event) => {
          if (!conflict.eventIds.includes(event.id)) {
            return event;
          }
          if (accepted.has(event.id)) {
            return { ...event, status: 'committed' as const };
          }
          return { ...event, status: 'dropped' as const };
        }),
        conflicts: ledger.conflicts.map((item) =>
          item.id === conflictId
            ? {
                ...item,
                status: 'resolved' as const,
                resolution,
                acceptedEventId: acceptedEventId,
                reviewedBy: reviewer,
                reviewedAt: now,
              }
            : item,
        ),
        lastRebuiltAt: now,
      };
      return {
        ...state,
        workspace: {
          ...state.workspace,
          ledgers: { ...state.workspace.ledgers, [changeId]: nextLedger },
        },
        changes: applyLedgerProjection(state.changes, nextLedger).map((change) =>
          change.id === changeId
            ? touch({
                ...change,
                audit: [
                  createAudit(
                    '冲突复核',
                    resolution === 'accept'
                      ? `${reviewer} 采纳事件 ${acceptedEventId}，其余舍弃`
                      : `${reviewer} 判定双方事件均舍弃`,
                  ),
                  ...change.audit,
                ],
              })
            : change,
        ),
      };
    },
  ),

  // 从合并账本还原：步骤、偏离和结论全部由重放结果覆盖。
  on(ChangeRequestActions.applyLedgerProjection, (state, { id, steps, deviations, status }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id) {
        return change;
      }
      const projected = touch({ ...change, steps, deviations });
      if (status) {
        return {
          ...projected,
          status,
          audit: [createAudit('账本还原', '已按合并账本重放结果还原执行过程'), ...change.audit],
        };
      }
      return projected;
    }),
  })),
);
