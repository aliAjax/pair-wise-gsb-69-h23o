import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { catchError, forkJoin, mergeMap, of, tap, withLatestFrom } from 'rxjs';
import {
  ExecutionEvent,
  newEventId,
  projectLedger as projectLedgerInline,
} from '../models/execution-ledger.model';
import { ChangeRequestService } from '../services/change-request.service';
import { ExecutionLedgerService } from '../services/execution-ledger.service';
import { ChangeRequestActions } from './change-request.actions';
import { selectAllChanges, selectLedgerWorkspace } from './change-request.selectors';

@Injectable()
export class ChangeRequestEffects {
  private readonly actions$ = inject(Actions);
  private readonly service = inject(ChangeRequestService);
  private readonly ledgerService = inject(ExecutionLedgerService);
  private readonly store = inject(Store);

  loadChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.loadChanges),
      mergeMap(() =>
        forkJoin({
          changes: this.service.load(),
          workspace: of(this.ledgerService.loadWorkspace()),
        }).pipe(
          mergeMap(({ changes, workspace }) => [
            ChangeRequestActions.loadLedgerWorkspaceSuccess({ workspace }),
            ChangeRequestActions.loadChangesSuccess({ changes }),
          ]),
          catchError((error: unknown) =>
            of(
              ChangeRequestActions.loadChangesFailure({
                error: error instanceof Error ? error.message : '变更数据加载失败',
              }),
            ),
          ),
        ),
      ),
    ),
  );

  // 事件提交即尝试写入：失败留在发件箱，成功并入合并账本。
  submitLedgerEvent$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.ledgerEventSubmitted),
      withLatestFrom(this.store.select(selectLedgerWorkspace)),
      mergeMap(([{ event }, workspace]) => {
        const result = this.ledgerService.attemptDelivery(workspace, event);
        if (!result.ok) {
          return of(
            ChangeRequestActions.ledgerEventDeliveryFailed({
              eventId: event.id,
              error: result.error ?? '写入失败',
            }),
          );
        }
        return of(ChangeRequestActions.ledgerEventDelivered({ event }));
      }),
    ),
  );

  // 断网恢复或故障解除后，对发件箱逐条重试并续作；事件幂等，不会重复入账。
  retryOutbox$ = createEffect(() =>
    this.actions$.pipe(
      ofType(
        ChangeRequestActions.retryOutbox,
        ChangeRequestActions.setSiteOnline,
        ChangeRequestActions.toggleFailureInjection,
      ),
      withLatestFrom(this.store.select(selectLedgerWorkspace)),
      mergeMap(([action, workspace]) => {
        const changeId = 'changeId' in action ? action.changeId : undefined;
        const pending = Object.values(workspace.ledgers)
          .filter((ledger) => !changeId || ledger.changeId === changeId)
          .flatMap((ledger) =>
            ledger.outbox
              .filter((entry) => entry.state === 'queued' || entry.state === 'failed')
              .map((entry) => ledger.events.find((event) => event.id === entry.eventId))
              .filter((event): event is ExecutionEvent => Boolean(event))
              // 已确认（包括冲突挂起）的事件不再重投，避免重复处理。
              .filter((event) => event.status === 'pending' || event.status === 'invalidated'),
          );

        return pending.map((event) => {
          const result = this.ledgerService.attemptDelivery(workspace, event);
          return result.ok
            ? ChangeRequestActions.ledgerEventDelivered({ event })
            : ChangeRequestActions.ledgerEventDeliveryFailed({
                eventId: event.id,
                error: result.error ?? '写入失败',
              });
        });
      }),
    ),
  );

  // 失效事件在当前版本/纪元上重新确认：保留事实、换新标识后重新提交。
  reconfirmEvent$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.reconfirmEvent),
      withLatestFrom(this.store.select(selectLedgerWorkspace)),
      mergeMap(([{ changeId, eventId }, workspace]) => {
        const ledger = workspace.ledgers[changeId];
        const original = ledger?.events.find((event) => event.id === eventId);
        if (!ledger || !original || original.status !== 'invalidated') {
          return [];
        }
        const now = new Date().toISOString();
        const renewed: ExecutionEvent = {
          ...original,
          id: newEventId(original.type),
          version: ledger.version,
          epoch: ledger.epoch,
          occurredAt: now,
          submittedAt: now,
          status: 'pending',
        };
        return [ChangeRequestActions.ledgerEventSubmitted({ event: renewed })];
      }),
    ),
  );

  // 从同一份合并账本还原已成立的操作与最终结论。
  rebuildFromLedger$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.rebuildFromLedger),
      withLatestFrom(this.store.select(selectAllChanges), this.store.select(selectLedgerWorkspace)),
      mergeMap(([{ id }, changes, workspace]) => {
        const ledger = workspace.ledgers[id];
        const change = changes.find((item) => item.id === id);
        if (!ledger || !change) {
          return [];
        }
        const projection = ledger ? projectLedgerInline(ledger) : null;
        if (!projection) {
          return [];
        }
        const steps = change.steps.map((step) => {
          const state = projection.stepState[step.id];
          return {
            ...step,
            completed: state?.done ?? false,
            completedAt: state?.done ? state.at : undefined,
          };
        });
        return [
          ChangeRequestActions.applyLedgerProjection({
            id,
            steps,
            deviations: projection.deviations,
            status: projection.outcome,
          }),
        ];
      }),
    ),
  );

  persistChanges$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(
          ChangeRequestActions.createChange,
          ChangeRequestActions.updateChange,
          ChangeRequestActions.deleteDraft,
          ChangeRequestActions.submitForReview,
          ChangeRequestActions.approveStage,
          ChangeRequestActions.rejectStage,
          ChangeRequestActions.startExecution,
          ChangeRequestActions.ledgerEventDelivered,
          ChangeRequestActions.ledgerEventDeliveryFailed,
          ChangeRequestActions.registerContextChange,
          ChangeRequestActions.resolveConflict,
          ChangeRequestActions.applyLedgerProjection,
        ),
        withLatestFrom(this.store.select(selectAllChanges)),
        tap(([, changes]) => this.service.save(changes)),
      ),
    { dispatch: false },
  );

  persistLedger$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(
          ChangeRequestActions.startExecution,
          ChangeRequestActions.switchSite,
          ChangeRequestActions.setSiteOnline,
          ChangeRequestActions.toggleFailureInjection,
          ChangeRequestActions.ledgerEventSubmitted,
          ChangeRequestActions.ledgerEventDelivered,
          ChangeRequestActions.ledgerEventDeliveryFailed,
          ChangeRequestActions.registerContextChange,
          ChangeRequestActions.resolveConflict,
        ),
        withLatestFrom(this.store.select(selectLedgerWorkspace)),
        tap(([, workspace]) => this.ledgerService.saveWorkspace(workspace)),
      ),
    { dispatch: false },
  );
}
