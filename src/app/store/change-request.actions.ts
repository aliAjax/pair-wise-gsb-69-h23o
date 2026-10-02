import { createActionGroup, emptyProps, props } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  ChangeStep,
  DeviationRecord,
} from '../models/change-request.model';
import {
  ConflictResolutionKind,
  ExecutionEvent,
  ExecutionOutcome,
  LedgerSiteId,
  LedgerWorkspace,
} from '../models/execution-ledger.model';

export const ChangeRequestActions = createActionGroup({
  source: 'Change Request',
  events: {
    'Load Changes': emptyProps(),
    'Load Changes Success': props<{ changes: ChangeRequest[] }>(),
    'Load Changes Failure': props<{ error: string }>(),
    'Load Ledger Workspace Success': props<{ workspace: LedgerWorkspace }>(),
    'Create Change': props<{ change: ChangeRequest }>(),
    'Update Change': props<{ change: ChangeRequest }>(),
    'Delete Draft': props<{ id: string }>(),
    'Submit For Review': props<{ id: string }>(),
    'Approve Stage': props<{
      id: string;
      stage: ApprovalStage;
      approver: string;
      comment: string;
    }>(),
    'Reject Stage': props<{
      id: string;
      stage: ApprovalStage;
      approver: string;
      comment: string;
    }>(),
    'Start Execution': props<{ id: string }>(),

    // ---- 双端事件账本：执行期所有事实都走事件提交 ----
    'Switch Site': props<{ site: LedgerSiteId }>(),
    'Set Site Online': props<{ site: LedgerSiteId; online: boolean }>(),
    'Toggle Failure Injection': props<{ enabled: boolean }>(),

    /** 某端提交执行事件，先入发件箱，等待确认。 */
    'Ledger Event Submitted': props<{ event: ExecutionEvent }>(),
    /** 传输成功：并入合并账本（可能产生冲突待复核）。 */
    'Ledger Event Delivered': props<{ event: ExecutionEvent }>(),
    /** 写入失败：停留在发件箱，可重试续作。 */
    'Ledger Event Delivery Failed': props<{ eventId: string; error: string }>(),

    'Retry Outbox': props<{ changeId?: string }>(),
    /** 失效事件在当前版本/纪元上重新确认（生成一条新事件）。 */
    'Reconfirm Event': props<{ changeId: string; eventId: string }>(),
    /** 窗口或资源依赖变化：版本递增，未确认事件失效。 */
    'Register Context Change': props<{ id: string; note: string }>(),
    'Resolve Conflict': props<{
      changeId: string;
      conflictId: string;
      resolution: ConflictResolutionKind;
      acceptedEventId?: string;
      reviewer: string;
    }>(),
    /** 从同一份合并账本重放并还原步骤、偏离与最终结论。 */
    'Rebuild From Ledger': props<{ id: string }>(),
    'Apply Ledger Projection': props<{
      id: string;
      steps: ChangeStep[];
      deviations: DeviationRecord[];
      status?: ExecutionOutcome;
    }>(),
  },
});
