import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { Store } from '@ngrx/store';
import { ChangeRequest } from '../../models/change-request.model';
import {
  ChangeLedger,
  EVENT_STATUS_LABELS,
  EVENT_TYPE_LABELS,
  ExecutionEvent,
  LedgerSiteId,
  SITE_LABELS,
  describeEvent,
  projectLedger,
} from '../../models/execution-ledger.model';
import { ChangeRequestActions } from '../../store/change-request.actions';
import { selectLedgerWorkspace } from '../../store/change-request.selectors';

@Component({
  selector: 'app-execution-ledger-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, ClarityModule],
  template: `
    @if (ledger(); as ledger) {
      <section class="surface ledger-panel">
        <div class="surface-heading">
          <div>
            <h2>双端事件账本</h2>
            <span>
              控制台与机房值守各留一份记录 · 当前版本 v{{ ledger.version }} · 纪元
              {{ ledger.epoch }}
            </span>
          </div>
          <button class="btn btn-sm" type="button" (click)="rebuild()">从合并账本还原</button>
        </div>

        <div class="site-bar">
          <div class="site-switch">
            <span class="bar-label">当前值守端</span>
            @for (site of sites; track site) {
              <button
                type="button"
                class="btn btn-sm"
                [class.btn-primary]="workspace().currentSite === site"
                (click)="switchSite(site)"
              >
                {{ siteLabel(site) }}
              </button>
            }
          </div>
          <div class="link-controls">
            @for (site of sites; track site) {
              <label class="link-toggle">
                <input
                  type="checkbox"
                  [checked]="workspace().online[site]"
                  (change)="setOnline(site, $any($event.target).checked)"
                />
                {{ siteLabel(site) }}在线
              </label>
            }
            <label class="link-toggle danger">
              <input
                type="checkbox"
                [checked]="workspace().injectFailure"
                (change)="toggleFailure($any($event.target).checked)"
              />
              模拟写入故障
            </label>
          </div>
        </div>

        @if (projection().conclusionBlocked) {
          <div class="banner warn">
            存在
            {{
              projection().openConflictCount
            }}
            组冲突待复核；在复核完成前，完成与回滚结论暂不成立。
          </div>
        }

        <div class="context-row">
          <input
            class="context-input"
            placeholder="登记窗口或资源依赖变化（例如：窗口顺延、机柜资源被 CHG-2201 占用）"
            [(ngModel)]="contextNote"
          />
          <button class="btn" type="button" (click)="registerContextChange()">窗口/依赖变化</button>
        </div>

        @if (pendingOutbox().length > 0) {
          <div class="ledger-section">
            <div class="section-head">
              <h3>发件箱 · 未确认 {{ pendingOutbox().length }} 条</h3>
              <button class="btn btn-sm btn-primary" type="button" (click)="retryOutbox()">
                重试并续作
              </button>
            </div>
            <ul class="entry-list">
              @for (entry of pendingOutbox(); track entry.eventId) {
                @if (eventById(entry.eventId); as event) {
                  <li [class.failed]="entry.state === 'failed'">
                    <div class="entry-main">
                      <strong>{{ describe(event) }}</strong>
                      <small>
                        {{ siteLabel(entry.site) }} · 已尝试 {{ entry.attempts }} 次 ·
                        {{ entry.state === 'failed' ? '写入失败' : '等待确认' }}
                        @if (entry.lastError) {
                          ：{{ entry.lastError }}
                        }
                      </small>
                    </div>
                    <span class="chip pending">{{ stateLabel(entry.state) }}</span>
                  </li>
                }
              }
            </ul>
          </div>
        }

        @if (invalidatedEvents().length > 0) {
          <div class="ledger-section">
            <div class="section-head">
              <h3>窗口/依赖变化后失效 {{ invalidatedEvents().length }} 条</h3>
            </div>
            <ul class="entry-list">
              @for (event of invalidatedEvents(); track event.id) {
                <li>
                  <div class="entry-main">
                    <strong>{{ describe(event) }}</strong>
                    <small
                      >提交于 v{{ event.version }}，当前为 v{{
                        ledger.version
                      }}，需在新版本重新确认</small
                    >
                  </div>
                  <button class="btn btn-sm" type="button" (click)="reconfirm(event.id)">
                    重新确认
                  </button>
                </li>
              }
            </ul>
          </div>
        }

        @if (openConflicts().length > 0) {
          <div class="ledger-section">
            <div class="section-head">
              <h3>冲突待复核 {{ openConflicts().length }} 组</h3>
            </div>
            @for (conflict of openConflicts(); track conflict.id) {
              <div class="conflict-card">
                <p class="conflict-key">
                  对账键：v{{ conflict.version }} · 步骤 {{ conflict.stepNo ?? '-' }} ·
                  {{ typeLabel(conflict.type) }} ·
                  {{ conflict.occurredAt | date: 'MM-dd HH:mm:ss' }}
                </p>
                <ul class="conflict-options">
                  @for (eventId of conflict.eventIds; track eventId) {
                    @if (eventById(eventId); as event) {
                      <li>
                        <div>
                          <strong>{{ describe(event) }}</strong>
                          <small>{{ siteLabel(event.site) }} · {{ event.actor }}</small>
                        </div>
                        <button
                          class="btn btn-sm btn-primary"
                          type="button"
                          (click)="accept(conflict.id, event.id)"
                        >
                          采纳此条
                        </button>
                      </li>
                    }
                  }
                </ul>
                <div class="conflict-footer">
                  <input [(ngModel)]="reviewer" placeholder="复核人" />
                  <button class="btn btn-sm" type="button" (click)="dropBoth(conflict.id)">
                    双方均舍弃
                  </button>
                </div>
              </div>
            }
          </div>
        }

        <div class="ledger-section">
          <div class="section-head">
            <h3>合并事件流（{{ ledger.events.length }}）</h3>
            <span class="muted">按变更版本、步骤编号和发生时间对账</span>
          </div>
          <ol class="event-stream">
            @for (event of orderedEvents(ledger); track event.id) {
              <li [class]="'st-' + event.status">
                <span class="ev-version">v{{ event.version }}/{{ event.stepNo ?? '·' }}</span>
                <time>{{ event.occurredAt | date: 'MM-dd HH:mm:ss' }}</time>
                <span class="ev-site">{{ siteLabel(event.site) }}</span>
                <span class="ev-desc">{{ describe(event) }}</span>
                <span class="chip" [class]="event.status">{{ statusLabel(event.status) }}</span>
              </li>
            }
          </ol>
        </div>
      </section>
    }
  `,
  styles: [
    `
      .ledger-panel {
        grid-column: 1 / -1;
      }

      .site-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        margin-top: 16px;
        padding: 12px 14px;
        background: #f4f6f7;
      }

      .site-switch,
      .link-controls {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .bar-label {
        color: #5f5f5f;
        font-size: 12px;
      }

      .link-toggle {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 12px;
        color: #414141;
      }

      .link-toggle.danger {
        color: #8e260f;
      }

      .banner {
        margin-top: 14px;
        padding: 10px 14px;
        font-size: 13px;
      }

      .banner.warn {
        border-left: 3px solid #c28a00;
        background: #fdf5e0;
        color: #7a5200;
      }

      .context-row {
        display: flex;
        gap: 10px;
        margin-top: 14px;
      }

      .context-input {
        flex: 1;
        padding: 7px 10px;
        border: 1px solid #c9c9c9;
      }

      .ledger-section {
        margin-top: 18px;
      }

      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
      }

      .section-head h3 {
        margin: 0;
        font-size: 14px;
      }

      .muted,
      .entry-main small {
        color: #737373;
        font-size: 11px;
      }

      .entry-list {
        margin: 0;
        padding: 0;
        list-style: none;
        border: 1px solid #e3e3e3;
      }

      .entry-list li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        border-bottom: 1px solid #ececec;
      }

      .entry-list li:last-child {
        border-bottom: 0;
      }

      .entry-list li.failed {
        background: #fbece8;
      }

      .entry-main {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .chip {
        padding: 2px 8px;
        font-size: 11px;
        white-space: nowrap;
        background: #edf3f6;
        color: #205d7e;
      }

      .chip.pending,
      .chip.pending-confirmed {
        background: #fdf5e0;
        color: #7a5200;
      }

      .chip.conflict {
        background: #fbece8;
        color: #8e260f;
      }

      .chip.committed {
        background: #e8f5ed;
        color: #245f3d;
      }

      .chip.invalidated,
      .chip.dropped {
        background: #ececec;
        color: #6f6f6f;
      }

      .conflict-card {
        margin-bottom: 10px;
        padding: 12px 14px;
        border: 1px solid #d58d7e;
        background: #fff7f5;
      }

      .conflict-key {
        margin: 0 0 10px;
        color: #8e260f;
        font-size: 12px;
      }

      .conflict-options {
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .conflict-options li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 0;
        border-bottom: 1px dashed #e6c9c1;
      }

      .conflict-options small {
        display: block;
        color: #737373;
        font-size: 11px;
      }

      .conflict-footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 10px;
      }

      .conflict-footer input {
        width: 140px;
        padding: 5px 8px;
        border: 1px solid #c9c9c9;
      }

      .event-stream {
        margin: 0;
        padding: 0;
        list-style: none;
        max-height: 280px;
        overflow-y: auto;
        border: 1px solid #e3e3e3;
      }

      .event-stream li {
        display: grid;
        grid-template-columns: 64px 110px 70px 1fr auto;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-bottom: 1px solid #efefef;
        font-size: 12px;
      }

      .event-stream li.st-conflict {
        background: #fff7f5;
      }

      .event-stream li.st-invalidated,
      .event-stream li.st-dropped {
        opacity: 0.65;
      }

      .event-stream time {
        color: #737373;
      }

      .ev-version {
        font-weight: 600;
        color: #266c91;
      }

      .ev-desc {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class ExecutionLedgerPanelComponent {
  private readonly store = inject(Store);
  readonly change = input.required<ChangeRequest>();

  readonly workspace = this.store.selectSignal(selectLedgerWorkspace);
  readonly ledger = computed<ChangeLedger | undefined>(
    () => this.workspace().ledgers[this.change().id],
  );
  readonly projection = computed(() => {
    const ledger = this.ledger();
    return ledger
      ? projectLedger(ledger)
      : {
          stepState: {},
          deviations: [],
          openConflictCount: 0,
          conclusionBlocked: false,
          committedEvents: [],
        };
  });

  readonly sites: LedgerSiteId[] = ['console', 'onsite'];
  readonly contextNote = signal('');
  readonly reviewer = signal('当前用户');

  readonly pendingOutbox = computed(() =>
    (this.ledger()?.outbox ?? []).filter(
      (entry) => entry.state === 'queued' || entry.state === 'failed',
    ),
  );

  readonly invalidatedEvents = computed(() =>
    (this.ledger()?.events ?? []).filter((event) => event.status === 'invalidated'),
  );

  readonly openConflicts = computed(() =>
    (this.ledger()?.conflicts ?? []).filter((conflict) => conflict.status === 'open'),
  );

  orderedEvents(ledger: ChangeLedger): ExecutionEvent[] {
    return [...ledger.events].sort((left, right) =>
      right.submittedAt.localeCompare(left.submittedAt),
    );
  }

  eventById(eventId: string): ExecutionEvent | undefined {
    return this.ledger()?.events.find((event) => event.id === eventId);
  }

  describe(event: ExecutionEvent): string {
    return describeEvent(event);
  }

  switchSite(site: LedgerSiteId): void {
    this.store.dispatch(ChangeRequestActions.switchSite({ site }));
  }

  setOnline(site: LedgerSiteId, online: boolean): void {
    this.store.dispatch(ChangeRequestActions.setSiteOnline({ site, online }));
  }

  toggleFailure(enabled: boolean): void {
    this.store.dispatch(ChangeRequestActions.toggleFailureInjection({ enabled }));
  }

  retryOutbox(): void {
    this.store.dispatch(ChangeRequestActions.retryOutbox({ changeId: this.change().id }));
  }

  reconfirm(eventId: string): void {
    this.store.dispatch(
      ChangeRequestActions.reconfirmEvent({ changeId: this.change().id, eventId }),
    );
  }

  registerContextChange(): void {
    const note = this.contextNote().trim();
    if (!note) {
      return;
    }
    this.store.dispatch(ChangeRequestActions.registerContextChange({ id: this.change().id, note }));
    this.contextNote.set('');
  }

  accept(conflictId: string, acceptedEventId: string): void {
    this.store.dispatch(
      ChangeRequestActions.resolveConflict({
        changeId: this.change().id,
        conflictId,
        resolution: 'accept',
        acceptedEventId,
        reviewer: this.reviewer().trim() || '当前用户',
      }),
    );
  }

  dropBoth(conflictId: string): void {
    this.store.dispatch(
      ChangeRequestActions.resolveConflict({
        changeId: this.change().id,
        conflictId,
        resolution: 'dropBoth',
        reviewer: this.reviewer().trim() || '当前用户',
      }),
    );
  }

  rebuild(): void {
    this.store.dispatch(ChangeRequestActions.rebuildFromLedger({ id: this.change().id }));
  }

  siteLabel(site: LedgerSiteId): string {
    return SITE_LABELS[site];
  }

  typeLabel(type: ExecutionEvent['type']): string {
    return EVENT_TYPE_LABELS[type];
  }

  statusLabel(status: ExecutionEvent['status']): string {
    return EVENT_STATUS_LABELS[status];
  }

  stateLabel(state: 'queued' | 'failed' | 'delivered' | 'superseded'): string {
    return {
      queued: '等待确认',
      failed: '写入失败',
      delivered: '已送达',
      superseded: '已被新版本取代',
    }[state];
  }
}
