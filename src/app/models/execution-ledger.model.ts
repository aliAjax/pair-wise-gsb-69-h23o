import { ChangeRequest, ChangeStep, DeviationRecord } from './change-request.model';

/** 两个值守端：控制台与机房现场各持一份账本。 */
export type LedgerSiteId = 'console' | 'onsite';

/** 执行期事件类型：步骤操作、执行偏离、处置/回滚结论、窗口或资源依赖变化。 */
export type ExecutionEventType = 'step' | 'deviation' | 'outcome' | 'context';

export type DeviationDecision = 'continue' | 'pause' | 'rollback';
export type ExecutionOutcome = 'completed' | 'rolled_back';

/**
 * 事件在合并账本中的生命周期：
 * - pending     已提交但尚未确认（断网或写入失败时停留在发件箱）
 * - committed   已确认并入合并账本，可参与重放
 * - invalidated 窗口/资源依赖变化后，未确认事件先失效，等待重新确认
 * - conflict    与对端同版本、同步骤、同时刻但内容相异，待人工复核
 * - dropped     冲突复核后被舍弃，仍保留在账本内可审计
 */
export type EventStatus = 'pending' | 'committed' | 'invalidated' | 'conflict' | 'dropped';

export type OutboxState = 'queued' | 'failed' | 'delivered' | 'superseded';

export type ConflictReason = 'payload-diverges';
export type ConflictResolutionKind = 'accept' | 'dropBoth';

export interface ExecutionEvent {
  /** 端上生成的幂等标识，写入失败重试时保持不变。 */
  id: string;
  changeId: string;
  /** 变更版本：随窗口或资源依赖变化递增，对账键的一部分。 */
  version: number;
  /** 上下文纪元：每次窗口/资源依赖变化递增。 */
  epoch: number;
  /** 步骤编号（按准备/执行/验证/回滚顺序，从 1 起）。 */
  stepNo?: number;
  stepId?: string;
  type: ExecutionEventType;
  /** 发生时间（ISO），对账与重放排序依据。 */
  occurredAt: string;
  /** 提交端。 */
  site: LedgerSiteId;
  actor: string;

  // 按类型使用的载荷
  stepDone?: boolean;
  deviationText?: string;
  decision?: DeviationDecision;
  outcome?: ExecutionOutcome;
  note?: string;

  status: EventStatus;
  conflictId?: string;
  submittedAt: string;
}

export interface OutboxEntry {
  eventId: string;
  site: LedgerSiteId;
  state: OutboxState;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerConflict {
  id: string;
  changeId: string;
  /** 对账键原文：变更版本|事件类型|步骤编号|发生时间。 */
  reconciliationKey: string;
  version: number;
  stepNo: number | null;
  type: ExecutionEventType;
  occurredAt: string;
  eventIds: string[];
  reason: ConflictReason;
  status: 'open' | 'resolved';
  resolution?: ConflictResolutionKind;
  acceptedEventId?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface ChangeLedger {
  changeId: string;
  /** 当前变更版本与上下文纪元。 */
  version: number;
  epoch: number;
  startedAt: string;
  /** 只追加的事件流，任何状态都不物理删除。 */
  events: ExecutionEvent[];
  outbox: OutboxEntry[];
  conflicts: LedgerConflict[];
  /** 已确认事件的入账顺序，用于同时刻的稳定排序。 */
  seq: number;
  lastRebuiltAt?: string;
}

export interface LedgerWorkspace {
  ledgers: Record<string, ChangeLedger>;
  currentSite: LedgerSiteId;
  online: Record<LedgerSiteId, boolean>;
  /** 演练用：开启后所有写入都失败，可关闭后重试续作。 */
  injectFailure: boolean;
}

export interface ProjectedStepState {
  done: boolean;
  at?: string;
  actor: string;
  site: LedgerSiteId;
  version: number;
}

export interface LedgerProjection {
  stepState: Record<string, ProjectedStepState>;
  deviations: DeviationRecord[];
  outcome?: ExecutionOutcome;
  outcomeAt?: string;
  openConflictCount: number;
  /** 有待复核冲突时，完成/回滚结论暂不成立。 */
  conclusionBlocked: boolean;
  committedEvents: ExecutionEvent[];
}

export const SITE_LABELS: Record<LedgerSiteId, string> = {
  console: '控制台',
  onsite: '机房值守',
};

export const EVENT_TYPE_LABELS: Record<ExecutionEventType, string> = {
  step: '步骤操作',
  deviation: '执行偏离',
  outcome: '结论判定',
  context: '窗口/依赖变化',
};

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  pending: '未确认',
  committed: '已确认',
  invalidated: '已失效',
  conflict: '冲突待复核',
  dropped: '复核舍弃',
};

export const DECISION_LABELS: Record<DeviationDecision, string> = {
  continue: '继续观察',
  pause: '暂停执行',
  rollback: '立即回滚',
};

export const OUTCOME_LABELS: Record<ExecutionOutcome, string> = {
  completed: '执行完成',
  rolled_back: '执行回滚',
};

export function createEmptyLedgerWorkspace(): LedgerWorkspace {
  return {
    ledgers: {},
    currentSite: 'console',
    online: { console: true, onsite: true },
    injectFailure: false,
  };
}

export function createChangeLedger(changeId: string, now: string): ChangeLedger {
  return {
    changeId,
    version: 1,
    epoch: 1,
    startedAt: now,
    events: [],
    outbox: [],
    conflicts: [],
    seq: 0,
  };
}

let idCounter = 0;

export function newEventId(prefix = 'evt'): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
}

/** 执行步骤的全局顺序：准备 → 执行 → 验证 → 回滚，组内按编号。 */
export function orderedSteps(change: ChangeRequest): ChangeStep[] {
  const phaseOrder: ChangeStep['phase'][] = ['prepare', 'execute', 'verify', 'rollback'];
  return [...change.steps].sort((left, right) => {
    const phase = phaseOrder.indexOf(left.phase) - phaseOrder.indexOf(right.phase);
    return phase !== 0 ? phase : left.id.localeCompare(right.id);
  });
}

/** 对账键：变更版本、步骤编号和发生时间（同类型事件之间比较）。 */
export function reconciliationKey(event: ExecutionEvent): string {
  return [event.version, event.type, event.stepNo ?? '-', event.occurredAt].join('|');
}

function payloadSignature(event: ExecutionEvent): string {
  switch (event.type) {
    case 'step':
      return `step:${event.stepDone ? 1 : 0}`;
    case 'deviation':
      return `deviation:${event.decision}:${(event.deviationText ?? '').trim()}`;
    case 'outcome':
      return `outcome:${event.outcome}`;
    default:
      return `context:${event.note ?? ''}`;
  }
}

export function isSamePayload(left: ExecutionEvent, right: ExecutionEvent): boolean {
  return payloadSignature(left) === payloadSignature(right);
}

/**
 * 把一个已送达的事件并入合并账本：
 * 提交时写入的 pending 占位记录在此被提升为已确认；
 * 已处理事件（committed/conflict/dropped）重复送达幂等忽略；
 * 只与“已送达”的事件对账：同键同载荷去重，同键载荷相异挂冲突待复核。
 * 返回更新后的账本（纯函数）。
 */
export function reconcileIntoLedger(ledger: ChangeLedger, event: ExecutionEvent): ChangeLedger {
  const existing = ledger.events.find((candidate) => candidate.id === event.id);

  // 同一事件已处理完成，重试送达直接忽略。
  if (
    existing &&
    (existing.status === 'committed' ||
      existing.status === 'conflict' ||
      existing.status === 'dropped')
  ) {
    return ledger;
  }

  const key = reconciliationKey(event);
  const peers = ledger.events.filter(
    (candidate) =>
      candidate.id !== event.id &&
      (candidate.status === 'committed' || candidate.status === 'conflict') &&
      reconciliationKey(candidate) === key,
  );
  const divergent = peers.filter((peer) => !isSamePayload(peer, event));

  // 提升本端 pending 占位，否则追加新记录。
  let events = existing
    ? ledger.events.map((candidate) =>
        candidate.id === event.id ? { ...event, status: 'committed' as const } : candidate,
      )
    : [...ledger.events, { ...event, status: 'committed' as const }];
  let conflicts = ledger.conflicts;
  let seq = ledger.seq + 1;

  if (divergent.length > 0) {
    const involvedIds = [...new Set([...divergent.map((peer) => peer.id), event.id])];
    const openConflict = ledger.conflicts.find(
      (conflict) => conflict.status === 'open' && conflict.reconciliationKey === key,
    );

    let conflict: LedgerConflict;
    if (openConflict) {
      conflict = {
        ...openConflict,
        eventIds: [...new Set([...openConflict.eventIds, ...involvedIds])],
      };
      conflicts = conflicts.map((item) => (item.id === conflict.id ? conflict : item));
    } else {
      conflict = {
        id: newEventId('cfl'),
        changeId: ledger.changeId,
        reconciliationKey: key,
        version: event.version,
        stepNo: event.stepNo ?? null,
        type: event.type,
        occurredAt: event.occurredAt,
        eventIds: involvedIds,
        reason: 'payload-diverges',
        status: 'open',
      };
      conflicts = [...conflicts, conflict];
    }

    events = events.map((item) =>
      involvedIds.includes(item.id)
        ? { ...item, status: 'conflict' as const, conflictId: conflict.id }
        : item,
    );
    // 冲突事件不占用重放顺序，等待复核结论。
    seq = ledger.seq;
  }

  return { ...ledger, events, conflicts, seq };
}

/** 从同一份合并账本重放执行态；完成或回滚只能从这里得出。 */
export function projectLedger(ledger: ChangeLedger): LedgerProjection {
  const committed = ledger.events
    .filter((event) => event.status === 'committed')
    .sort((left, right) => {
      const time = left.occurredAt.localeCompare(right.occurredAt);
      return time !== 0 ? time : left.submittedAt.localeCompare(right.submittedAt);
    });

  const stepState: Record<string, ProjectedStepState> = {};
  const deviations: DeviationRecord[] = [];
  let outcome: ExecutionOutcome | undefined;
  let outcomeAt: string | undefined;

  committed.forEach((event) => {
    if (event.type === 'step' && event.stepId) {
      stepState[event.stepId] = {
        done: Boolean(event.stepDone),
        at: event.occurredAt,
        actor: event.actor,
        site: event.site,
        version: event.version,
      };
    } else if (event.type === 'deviation') {
      deviations.push({
        id: event.id,
        recordedAt: event.occurredAt,
        owner: `${SITE_LABELS[event.site]}·${event.actor}`,
        description: event.deviationText ?? '',
        decision: event.decision ?? 'continue',
      });
    } else if (event.type === 'outcome') {
      outcome = event.outcome;
      outcomeAt = event.occurredAt;
    }
  });

  const openConflictCount = ledger.conflicts.filter(
    (conflict) => conflict.status === 'open',
  ).length;

  return {
    stepState,
    deviations,
    outcome: openConflictCount > 0 ? undefined : outcome,
    outcomeAt: openConflictCount > 0 ? undefined : outcomeAt,
    openConflictCount,
    conclusionBlocked: openConflictCount > 0,
    committedEvents: committed,
  };
}

/** 账本是否已得出最终结论。 */
export function isLedgerTerminal(ledger: ChangeLedger): boolean {
  if (ledger.conflicts.some((conflict) => conflict.status === 'open')) {
    return false;
  }
  return ledger.events.some((event) => event.type === 'outcome' && event.status === 'committed');
}

export function describeEvent(event: ExecutionEvent): string {
  switch (event.type) {
    case 'step':
      return `步骤 ${event.stepNo ?? '-'} ${event.stepDone ? '勾选完成' : '取消完成'}`;
    case 'deviation':
      return `偏离记录：${event.deviationText ?? ''}（${DECISION_LABELS[event.decision ?? 'continue']}）`;
    case 'outcome':
      return OUTCOME_LABELS[event.outcome ?? 'completed'];
    case 'context':
      return `窗口/资源依赖变化：${event.note ?? '未填写说明'}（版本升至 v${event.version}）`;
  }
}
