import { createFeatureSelector, createSelector } from '@ngrx/store';
import { projectLedger } from '../models/execution-ledger.model';
import { ChangeRequestState } from './change-request.reducer';

export const selectChangeRequestState = createFeatureSelector<ChangeRequestState>('changeRequests');

export const selectAllChanges = createSelector(selectChangeRequestState, (state) => state.changes);

export const selectChangesLoading = createSelector(
  selectChangeRequestState,
  (state) => state.loading,
);

export const selectChangesError = createSelector(selectChangeRequestState, (state) => state.error);

export const selectLedgerWorkspace = createSelector(
  selectChangeRequestState,
  (state) => state.workspace,
);

export const selectCurrentSite = createSelector(
  selectLedgerWorkspace,
  (workspace) => workspace.currentSite,
);

export const selectSiteOnline = (site: 'console' | 'onsite') =>
  createSelector(selectLedgerWorkspace, (workspace) => workspace.online[site]);

export const selectFailureInjection = createSelector(
  selectLedgerWorkspace,
  (workspace) => workspace.injectFailure,
);

export const selectLedgerByChangeId = (id: string) =>
  createSelector(selectLedgerWorkspace, (workspace) => workspace.ledgers[id]);

export const selectLedgerProjection = (id: string) =>
  createSelector(selectLedgerByChangeId(id), (ledger) => (ledger ? projectLedger(ledger) : null));

export const selectOpenConflicts = (id: string) =>
  createSelector(
    selectLedgerByChangeId(id),
    (ledger) => ledger?.conflicts.filter((conflict) => conflict.status === 'open') ?? [],
  );

export const selectLedgerOutbox = (id: string) =>
  createSelector(
    selectLedgerByChangeId(id),
    (ledger) => ledger?.outbox.filter((entry) => entry.state !== 'delivered') ?? [],
  );

export const selectChangeById = (id: string) =>
  createSelector(selectAllChanges, (changes) => changes.find((change) => change.id === id));
