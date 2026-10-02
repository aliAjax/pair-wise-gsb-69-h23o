import { DatePipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { Store } from '@ngrx/store';
import { AuditTrailComponent } from '../../components/audit-trail/audit-trail.component';
import { DependencyGraphComponent } from '../../components/dependency-graph/dependency-graph.component';
import { ValidationPanelComponent } from '../../components/validation-panel/validation-panel.component';
import { WindowGanttComponent } from '../../components/window-gantt/window-gantt.component';
import {
  ApprovalStage,
  ChangeRequest,
  ChangeStep,
  DeviationRecord,
  PHASE_LABELS,
  RESOURCE_LABELS,
  RISK_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  validateChange,
} from '../../models/change-request.model';
import {
  EVENT_CONFIRMATION_LABELS,
  EXECUTION_EVENT_LABELS,
  EXECUTION_SOURCE_LABELS,
  ExecutionEvent,
  ExecutionSource,
} from '../../models/execution-ledger';
import {
  ProjectedExecution,
  materializeProjectedChange,
  projectExecution,
} from '../../models/execution-projection';
import { ChangeRequestService } from '../../services/change-request.service';
import { ChangeRequestActions } from '../../store/change-request.actions';
import { selectAllChanges, selectChangesError } from '../../store/change-request.selectors';

type DetailTab = 'overview' | 'dependency' | 'window' | 'execution' | 'approval' | 'audit';

@Component({
  selector: 'app-change-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    NgClass,
    FormsModule,
    RouterLink,
    ClarityModule,
    AuditTrailComponent,
    DependencyGraphComponent,
    ValidationPanelComponent,
    WindowGanttComponent,
  ],
  template: `
    @if (change(); as item) {
      <section class="detail-heading">
        <div class="heading-main">
          <a routerLink="/" class="back-link">返回变更队列</a>
          <div class="title-row">
            <div>
              <span class="change-id">{{ item.id }}</span>
              <h1>{{ item.title }}</h1>
            </div>
            <span class="status" [class]="(effectiveChange() ?? item).status">{{
              statusLabel((effectiveChange() ?? item).status)
            }}</span>
          </div>
          <p>{{ item.summary || '尚未填写变更摘要。' }}</p>
        </div>
        <div class="heading-meta">
          <div>
            <span>负责人</span>
            <strong>{{ item.owner }}</strong>
          </div>
          <div>
            <span>风险</span>
            <strong>{{ riskLabel(item.risk) }}</strong>
          </div>
          <div>
            <span>更新</span>
            <strong>{{ item.updatedAt | date: 'MM-dd HH:mm' }}</strong>
          </div>
        </div>
      </section>

      <nav class="tab-nav" aria-label="变更详情">
        @for (tab of tabs; track tab.id) {
          <button
            type="button"
            [class.active]="selectedTab() === tab.id"
            (click)="selectedTab.set(tab.id)"
          >
            {{ tab.label }}
            @if (tab.id === 'approval' && pendingStage(); as stage) {
              <span class="nav-badge">{{ stageLabel(stage) }}</span>
            }
          </button>
        }
      </nav>

      @switch (selectedTab()) {
        @case ('overview') {
          <div class="content-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>方案概览</h2>
                  <span>影响范围、值班和执行边界</span>
                </div>
                <button
                  class="btn btn-sm"
                  type="button"
                  (click)="editing() ? cancelEdit() : beginEdit()"
                  [disabled]="item.status === 'completed' || item.status === 'rolled_back'"
                >
                  {{ editing() ? '取消编辑' : '编辑方案' }}
                </button>
              </div>

              @if (editing()) {
                <div class="edit-form">
                  <clr-input-container>
                    <label>标题</label>
                    <input
                      clrInput
                      [ngModel]="draft()?.title"
                      (ngModelChange)="updateDraft('title', $event)"
                    />
                  </clr-input-container>
                  <clr-textarea-container>
                    <label>摘要</label>
                    <textarea
                      clrTextarea
                      rows="3"
                      [ngModel]="draft()?.summary"
                      (ngModelChange)="updateDraft('summary', $event)"
                    ></textarea>
                  </clr-textarea-container>
                  <div class="edit-grid">
                    <clr-input-container>
                      <label>窗口开始</label>
                      <input
                        clrInput
                        type="datetime-local"
                        [ngModel]="draft()?.window?.start"
                        (ngModelChange)="updateDraftWindow('start', $event)"
                      />
                    </clr-input-container>
                    <clr-input-container>
                      <label>窗口结束</label>
                      <input
                        clrInput
                        type="datetime-local"
                        [ngModel]="draft()?.window?.end"
                        (ngModelChange)="updateDraftWindow('end', $event)"
                      />
                    </clr-input-container>
                    <clr-input-container>
                      <label>观察窗口（分钟）</label>
                      <input
                        clrNumberInput
                        type="number"
                        [ngModel]="draft()?.window?.observationWindowMinutes"
                        (ngModelChange)="updateObservation($event)"
                      />
                    </clr-input-container>
                  </div>
                  <div class="edit-actions">
                    <button class="btn btn-primary" type="button" (click)="saveEdit()">
                      保存方案
                    </button>
                  </div>
                </div>
              } @else {
                <dl class="facts">
                  <div>
                    <dt>执行窗口</dt>
                    <dd>
                      {{ item.window.start | date: 'yyyy-MM-dd HH:mm' }} 至
                      {{ item.window.end | date: 'yyyy-MM-dd HH:mm' }}
                    </dd>
                  </div>
                  <div>
                    <dt>观察窗口</dt>
                    <dd>{{ item.window.observationWindowMinutes }} 分钟</dd>
                  </div>
                  <div>
                    <dt>值守人员</dt>
                    <dd>{{ item.onCall.join('、') }}</dd>
                  </div>
                  <div>
                    <dt>当前门禁</dt>
                    <dd>
                      {{ pendingStage() ? stageLabel(pendingStage()!) + '待会签' : approvalGate() }}
                    </dd>
                  </div>
                </dl>
              }
            </section>

            <app-validation-panel [change]="item" [allChanges]="changes()" />

            <section class="surface span-2">
              <div class="surface-heading">
                <div>
                  <h2>资源清单</h2>
                  <span>{{ item.resources.length }} 个对象，明确关键资源依赖</span>
                </div>
              </div>
              <div class="resource-table">
                @for (resource of item.resources; track resource.id) {
                  <article>
                    <span class="type">{{ resourceLabel(resource.type) }}</span>
                    <div>
                      <strong>{{ resource.name }}</strong>
                      <small>{{ resource.id }}</small>
                    </div>
                    <span>{{ resource.critical ? '关键资源' : '一般资源' }}</span>
                    <span>依赖 {{ resource.dependencies.length }} 项</span>
                  </article>
                } @empty {
                  <p class="empty">未配置资源。</p>
                }
              </div>
            </section>
          </div>
        }

        @case ('dependency') {
          <section class="surface">
            <div class="surface-heading">
              <div>
                <h2>依赖关系图</h2>
                <span>虚线表示依赖资源未纳入本次影响范围</span>
              </div>
            </div>
            <app-dependency-graph [change]="item" />
          </section>
        }

        @case ('window') {
          <section class="surface">
            <div class="surface-heading">
              <div>
                <h2>窗口与资源冲突</h2>
                <span>按 09-29 至 10-02 展示所有有效窗口</span>
              </div>
            </div>
            <app-window-gantt [changes]="changes()" [selectedId]="item.id" />
            <div class="conflict-notes">
              @for (issue of issues(); track issue.id) {
                @if (issue.code === 'WINDOW_CONFLICT') {
                  <article>
                    <strong>{{ issue.title }}</strong>
                    <p>{{ issue.detail }}</p>
                    <span>{{ issue.suggestedAction }}</span>
                  </article>
                }
              } @empty {
                <p class="empty">当前没有窗口冲突。</p>
              }
            </div>
          </section>
        }

        @case ('execution') {
          @if (projection(); as projected) {
            <div class="content-grid execution-grid">
              <section class="surface">
                <div class="surface-heading">
                  <div>
                    <h2>执行步骤</h2>
                    <span>
                      版本 {{ item.executionLedger?.basis.revision ?? 1 }}；按步骤编号与发生时间对账
                    </span>
                  </div>
                  @if (item.status === 'approved') {
                    <button class="btn btn-primary" type="button" (click)="startExecution()">
                      开始执行
                    </button>
                  }
                </div>
                <div class="source-strip">
                  <label>
                    当前记录端
                    <select [ngModel]="activeSource()" (ngModelChange)="setSource($event)">
                      <option value="console">控制台</option>
                      <option value="datacenter">机房值守</option>
                    </select>
                  </label>
                  <span>
                    待确认 {{ projected.unconfirmedCount }} · 冲突
                    {{ projected.openConflictCount }} · 失效
                    {{ projected.invalidatedCount }}
                  </span>
                </div>
                <div class="step-list">
                  @for (step of projected.steps; track step.id) {
                    @let pending = pendingStepEvents(step.id);
                    <label
                      class="step-row"
                      [class.completed]="step.completed"
                      [class.pending]="pending.length"
                    >
                      <input
                        type="checkbox"
                        [checked]="step.completed"
                        [indeterminate]="pending.length > 0"
                        [disabled]="item.status !== 'executing' || pending.length > 0"
                        (change)="toggleStep(step.id)"
                      />
                      <span class="phase">{{ phaseLabel(step.phase) }}</span>
                      <div>
                        <strong>{{ step.title }}</strong>
                        <code>{{ step.command || '未填写命令' }}</code>
                        @if (pending.length) {
                          <small class="pending-note">
                            {{ sourceLabel(pending[0].source) }}
                            {{ pending[0].type === 'step-completed' ? '完成' : '重开' }}待对账
                          </small>
                        }
                      </div>
                      <span class="step-side">
                        {{ step.owner || '未指定' }}
                        @if (pending.length === 1) {
                          <div class="step-actions">
                            <button
                              class="btn btn-sm btn-outline"
                              type="button"
                              (click)="reportCounterpartStep(pending[0], false, $event)"
                            >
                              对端同报
                            </button>
                            <button
                              class="btn btn-sm btn-outline"
                              type="button"
                              (click)="reportCounterpartStep(pending[0], true, $event)"
                            >
                              对端异议
                            </button>
                          </div>
                        }
                      </span>
                    </label>
                  } @empty {
                    <p class="empty">没有执行步骤。</p>
                  }
                </div>
              </section>

              <section class="surface">
                <div class="surface-heading">
                  <div>
                    <h2>实时执行记录</h2>
                    <span>两端各持一份；断网恢复后合并，不覆盖原记录</span>
                  </div>
                  <a
                    class="btn btn-sm"
                    href="https://logs.example.internal/change/{{ item.id }}"
                    target="_blank"
                    rel="noopener"
                  >
                    实时日志
                  </a>
                </div>
                @if (item.status === 'executing') {
                  <div class="deviation-form">
                    <clr-textarea-container>
                      <label>偏离说明</label>
                      <textarea
                        clrTextarea
                        rows="3"
                        [ngModel]="deviationText()"
                        (ngModelChange)="deviationText.set($event)"
                        placeholder="描述实际执行与方案差异"
                      ></textarea>
                    </clr-textarea-container>
                    <div class="deviation-actions">
                      <clr-select-container>
                        <label>处置决定</label>
                        <select
                          clrSelect
                          [ngModel]="deviationDecision()"
                          (ngModelChange)="deviationDecision.set($event)"
                        >
                          <option value="continue">继续观察</option>
                          <option value="pause">暂停执行</option>
                          <option value="rollback">立即回滚</option>
                        </select>
                      </clr-select-container>
                      <button class="btn" type="button" (click)="recordDeviation()">
                        {{ sourceLabel(activeSource()) }}记录偏离
                      </button>
                    </div>
                  </div>
                  <div class="completion-actions">
                    <button
                      class="btn"
                      type="button"
                      [disabled]="!canFinish(projected, 'rolled_back')"
                      (click)="complete('rolled_back')"
                    >
                      判定回滚
                    </button>
                    <button
                      class="btn btn-primary"
                      type="button"
                      [disabled]="!canFinish(projected, 'completed')"
                      (click)="complete('completed')"
                    >
                      执行完成
                    </button>
                  </div>
                  @if (!canFinish(projected, 'completed')) {
                    <p class="rule-note">
                      先完成非回滚步骤，并对所有待确认、冲突或依据失效事件对账/复核。
                    </p>
                  }
                }
                <div class="deviation-list">
                  @for (deviation of projected.deviations; track deviation.id) {
                    <article>
                      <div>
                        <strong>{{ deviation.owner }}</strong>
                        <time>{{ deviation.recordedAt | date: 'MM-dd HH:mm' }}</time>
                      </div>
                      <p>{{ deviation.description }}</p>
                      <span>{{ decisionLabel(deviation.decision) }}</span>
                    </article>
                  } @empty {
                    <p class="empty">尚无执行偏离。</p>
                  }
                </div>
              </section>

              <section class="surface span-2">
                <div class="surface-heading">
                  <div>
                    <h2>事件账本</h2>
                    <span>
                      对账键：变更版本 {{ item.executionLedger?.basis.revision ?? 1 }} + 步骤编号 +
                      发生时间；已冻结审批不参与合并
                    </span>
                  </div>
                  <div class="ledger-toolbar">
                    <button class="btn btn-sm" type="button" (click)="simulateWriteFailure()">
                      模拟下次写入失败
                    </button>
                    @if (saveError(); as error) {
                      <button class="btn btn-sm btn-warning" type="button" (click)="retrySave()">
                        重试写入：{{ error }}
                      </button>
                    }
                    <button class="btn btn-sm btn-primary" type="button" (click)="reconcile()">
                      断网重连 / 立即对账
                    </button>
                  </div>
                </div>
                @if (item.executionLedger; as ledger) {
                  <div class="ledger-meta">
                    <span>版本 {{ ledger.basis.revision }}</span>
                    <span>窗口 {{ ledger.basis.windowHash }}</span>
                    <span>资源 {{ ledger.basis.resourceHash }}</span>
                    <span>步骤 {{ ledger.basis.stepHash }}</span>
                    <span
                      >上次对账：{{
                        ledger.lastReconciledAt
                          ? (ledger.lastReconciledAt | date: 'MM-dd HH:mm:ss')
                          : '未对账'
                      }}</span
                    >
                  </div>
                  <div class="ledger-table">
                    @for (event of ledgerEvents(); track event.id) {
                      <article [class]="event.status">
                        <time>{{ event.occurredAt | date: 'MM-dd HH:mm:ss' }}</time>
                        <span class="source">{{ sourceLabel(event.source) }}</span>
                        <strong>{{ eventLabel(event.type) }}</strong>
                        <span
                          >v{{ event.changeVersion }} /
                          {{ event.stepNo ? '步骤 ' + event.stepNo : '全局' }}</span
                        >
                        <span class="confirm-state">{{ confirmationLabel(event.status) }}</span>
                        <span class="write-state" [class.failed]="event.writeState === 'failed'">
                          {{
                            event.writeState === 'failed'
                              ? '写入失败'
                              : event.writeState === 'written'
                                ? '已写入'
                                : '待写入'
                          }}
                        </span>
                        <div class="ledger-actions">
                          @if (
                            event.status === 'unconfirmed' && event.type === 'deviation-recorded'
                          ) {
                            <button
                              class="btn btn-sm"
                              type="button"
                              (click)="counterDeviation(event)"
                            >
                              对端同报偏离
                            </button>
                          }
                          @if (event.status === 'unconfirmed' && isTerminal(event.type)) {
                            <button
                              class="btn btn-sm"
                              type="button"
                              (click)="counterTerminal(event.type)"
                            >
                              对端同报结论
                            </button>
                            <button
                              class="btn btn-sm btn-outline"
                              type="button"
                              (click)="counterTerminal(event.type, true)"
                            >
                              对端相反结论
                            </button>
                          }
                          @if (event.status === 'conflict') {
                            <button
                              class="btn btn-sm btn-outline"
                              type="button"
                              (click)="resolveConflict(event.id, true)"
                            >
                              采纳本端
                            </button>
                          }
                          @if (event.status === 'invalidated') {
                            <button
                              class="btn btn-sm btn-outline"
                              type="button"
                              (click)="reconfirm(event.id)"
                            >
                              重新确认
                            </button>
                          }
                        </div>
                      </article>
                    } @empty {
                      <p class="empty">尚未产生执行事件。</p>
                    }
                  </div>
                } @else {
                  <p class="empty">审批通过并开始执行后，两端事件会进入同一份账本合并结果。</p>
                }
              </section>
            </div>
          }
        }

        @case ('approval') {
          <div class="content-grid approval-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>顺序会签</h2>
                  <span>必须按网络、系统、安全、业务顺序完成</span>
                </div>
                @if (item.status === 'draft' || item.status === 'rejected') {
                  <button
                    class="btn btn-primary"
                    type="button"
                    (click)="submitForReview()"
                    [disabled]="hasBlockers()"
                  >
                    提交审批
                  </button>
                }
              </div>
              <ol class="approval-flow">
                @for (approval of item.approvals; track approval.stage) {
                  <li [ngClass]="approval.state">
                    <span class="flow-index">{{ $index + 1 }}</span>
                    <div>
                      <strong>{{ stageLabel(approval.stage) }}</strong>
                      <p>
                        {{ approval.comment || approvalStateText(approval.state) }}
                      </p>
                      @if (approval.approver) {
                        <small>
                          {{ approval.approver }} · {{ approval.decidedAt | date: 'MM-dd HH:mm' }}
                        </small>
                      }
                    </div>
                  </li>
                }
              </ol>
            </section>

            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>会签操作</h2>
                  <span>只有当前顺位负责人可以签署</span>
                </div>
              </div>
              @if (pendingStage(); as stage) {
                @if (item.status === 'submitted' || item.status === 'rejected') {
                  <div class="approval-form">
                    <clr-input-container>
                      <label>审批人</label>
                      <input
                        clrInput
                        [ngModel]="approver()"
                        (ngModelChange)="approver.set($event)"
                      />
                    </clr-input-container>
                    <clr-textarea-container>
                      <label>意见</label>
                      <textarea
                        clrTextarea
                        rows="3"
                        [ngModel]="approvalComment()"
                        (ngModelChange)="approvalComment.set($event)"
                      ></textarea>
                    </clr-textarea-container>
                    <div class="approval-actions">
                      <button class="btn" type="button" (click)="reject(stage)">退回</button>
                      <button class="btn btn-primary" type="button" (click)="approve(stage)">
                        批准 {{ stageLabel(stage) }}
                      </button>
                    </div>
                  </div>
                } @else {
                  <p class="empty">当前状态不允许审批操作。</p>
                }
              } @else {
                <p class="approved-message">会签已完成。开始执行后审批记录自动冻结，不允许修改。</p>
              }
            </section>

            <section class="surface span-2">
              <div class="surface-heading">
                <div>
                  <h2>审批冻结快照</h2>
                  <span>执行与复盘以冻结版本为准</span>
                </div>
              </div>
              <div class="freeze-strip">
                @for (approval of item.approvals; track approval.stage) {
                  <div>
                    <span>{{ stageLabel(approval.stage) }}</span>
                    <strong>{{ approvalStateText(approval.state) }}</strong>
                  </div>
                }
              </div>
            </section>
          </div>
        }

        @case ('audit') {
          @if (effectiveChange(); as effective) {
            <div class="content-grid audit-grid">
              <section class="surface">
                <div class="surface-heading">
                  <div>
                    <h2>审计轨迹</h2>
                    <span>创建、编辑、会签、事件合并、复核、执行和回滚均记录</span>
                  </div>
                  <button class="btn btn-sm" type="button" (click)="exportRetrospective()">
                    导出复盘记录
                  </button>
                </div>
                <app-audit-trail [records]="effective.audit" />
              </section>
              <section class="surface">
                <div class="surface-heading">
                  <div>
                    <h2>复盘摘要</h2>
                    <span>完成或回滚均取自同一份合并账本结果</span>
                  </div>
                </div>
                <dl class="facts compact">
                  <div>
                    <dt>最终状态</dt>
                    <dd>{{ statusLabel(effective.status) }}</dd>
                  </div>
                  <div>
                    <dt>执行偏离</dt>
                    <dd>{{ effective.deviations.length }} 条</dd>
                  </div>
                  <div>
                    <dt>审计事件</dt>
                    <dd>{{ effective.audit.length }} 条</dd>
                  </div>
                  <div>
                    <dt>完成步骤</dt>
                    <dd>{{ completedSteps(effective) }} / {{ effective.steps.length }}</dd>
                  </div>
                </dl>
                <div class="retrospective-note">
                  <strong>导出内容</strong>
                  <p>包含变更窗口、资源范围、确认后的执行偏离、最终状态和完整审计轨迹。</p>
                </div>
              </section>
            </div>
          }
        }
      }
    } @else {
      <section class="not-found">
        <h1>变更不存在</h1>
        <p>该记录可能已被删除，或链接中的编号无效。</p>
        <a class="btn btn-primary" routerLink="/">返回变更队列</a>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .detail-heading {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 24px;
        padding: 20px 0 24px;
        border-bottom: 1px solid #d7d7d7;
      }

      .back-link {
        display: inline-block;
        margin-bottom: 14px;
        font-size: 12px;
      }

      .title-row {
        display: flex;
        align-items: center;
        gap: 14px;
      }

      .change-id {
        color: #266c91;
        font-size: 12px;
        font-weight: 600;
      }

      h1 {
        margin: 2px 0 0;
        font-size: 28px;
      }

      .heading-main > p {
        max-width: 760px;
        margin: 12px 0 0;
        color: #5e5e5e;
      }

      .heading-meta {
        display: grid;
        grid-template-columns: repeat(3, minmax(90px, 1fr));
        align-self: end;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      .heading-meta div {
        padding: 12px 16px;
        border-left: 1px solid #e1e1e1;
      }

      .heading-meta div:first-child {
        border-left: 0;
      }

      .heading-meta span,
      .heading-meta strong {
        display: block;
      }

      .heading-meta span {
        color: #6d6d6d;
        font-size: 11px;
      }

      .heading-meta strong {
        margin-top: 4px;
        font-size: 13px;
      }

      .status {
        padding: 3px 9px;
        border: 1px solid #9a9a9a;
        background: #f3f3f3;
        color: #474747;
        font-size: 12px;
      }

      .status.submitted,
      .status.approved {
        border-color: #5688a5;
        background: #eaf4f9;
        color: #1d5877;
      }

      .status.executing,
      .status.completed {
        border-color: #75a489;
        background: #edf7f0;
        color: #245f3d;
      }

      .status.rejected,
      .status.rolled_back {
        border-color: #d58d7e;
        background: #fbece8;
        color: #8e260f;
      }

      .tab-nav {
        display: flex;
        gap: 0;
        margin-bottom: 20px;
        border-bottom: 1px solid #d7d7d7;
        overflow-x: auto;
      }

      .tab-nav button {
        position: relative;
        padding: 13px 18px;
        border: 0;
        border-bottom: 3px solid transparent;
        background: transparent;
        color: #575757;
        cursor: pointer;
        white-space: nowrap;
      }

      .tab-nav button.active {
        border-bottom-color: #266c91;
        color: #174d6a;
        font-weight: 600;
      }

      .nav-badge {
        margin-left: 6px;
        padding: 1px 5px;
        background: #eaf4f9;
        color: #215a78;
        font-size: 10px;
      }

      .content-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .surface {
        padding: 18px;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      .span-2 {
        grid-column: 1 / -1;
      }

      .surface-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding-bottom: 14px;
        border-bottom: 1px solid #e3e3e3;
      }

      .surface-heading h2 {
        margin: 0;
        font-size: 17px;
      }

      .surface-heading span {
        color: #666;
        font-size: 12px;
      }

      .facts {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 1px;
        margin: 18px 0 0;
        background: #e1e1e1;
      }

      .facts div {
        padding: 14px;
        background: #fafafa;
      }

      .facts dt {
        color: #666;
        font-size: 12px;
      }

      .facts dd {
        margin: 5px 0 0;
        font-weight: 600;
      }

      .facts.compact {
        margin-top: 16px;
      }

      .edit-form {
        padding-top: 18px;
      }

      .edit-grid,
      .deviation-actions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }

      .edit-actions,
      .completion-actions,
      .approval-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 16px;
      }

      .resource-table article {
        display: grid;
        grid-template-columns: 80px minmax(180px, 1fr) 100px 120px;
        align-items: center;
        gap: 14px;
        padding: 12px 4px;
        border-bottom: 1px solid #e6e6e6;
      }

      .resource-table article:last-child {
        border-bottom: 0;
      }

      .resource-table article div {
        display: flex;
        flex-direction: column;
      }

      .resource-table small,
      .resource-table article > span:last-child {
        color: #6b6b6b;
        font-size: 11px;
      }

      .type,
      .phase {
        display: inline-block;
        width: fit-content;
        padding: 2px 7px;
        background: #edf3f6;
        color: #205d7e;
        font-size: 11px;
      }

      .conflict-notes {
        margin-top: 16px;
      }

      .conflict-notes article {
        padding: 14px;
        border-left: 3px solid #c21d00;
        background: #fbece8;
      }

      .conflict-notes p {
        margin: 6px 0;
      }

      .conflict-notes span {
        color: #8e260f;
        font-size: 12px;
      }

      .step-row {
        display: grid;
        grid-template-columns: 20px 50px 1fr 90px;
        align-items: center;
        gap: 12px;
        padding: 14px 2px;
        border-bottom: 1px solid #e6e6e6;
      }

      .step-row.completed {
        background: #f5faf6;
      }

      .step-row.pending {
        background: #fff8e5;
      }

      .pending-note,
      .rule-note {
        color: #8a5a00;
        font-size: 11px;
      }

      .step-side {
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-end;
        font-size: 12px;
      }

      .step-actions {
        display: flex;
        gap: 6px;
      }

      .source-strip,
      .ledger-meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 0;
        color: #5f5f5f;
        font-size: 12px;
      }

      .source-strip select {
        margin-left: 8px;
      }

      .ledger-toolbar {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }

      .btn-warning {
        border-color: #d58d00;
        background: #fff3d2;
        color: #7a4d00;
      }

      .ledger-meta {
        justify-content: flex-start;
        border-bottom: 1px solid #e6e6e6;
      }

      .ledger-table article {
        display: grid;
        grid-template-columns: 130px 80px minmax(140px, 1fr) 110px 110px 90px auto;
        align-items: center;
        gap: 10px;
        padding: 11px 4px;
        border-bottom: 1px solid #e8e8e8;
        font-size: 12px;
      }

      .ledger-table article time {
        color: #666;
      }

      .ledger-table .source {
        color: #205d7e;
      }

      .confirm-state,
      .write-state {
        padding: 2px 6px;
        background: #f1f1f1;
        text-align: center;
      }

      .ledger-table article.conflict .confirm-state,
      .write-state.failed {
        background: #fbece8;
        color: #8e260f;
      }

      .ledger-table article.invalidated .confirm-state {
        background: #fff3d2;
        color: #7a4d00;
      }

      .ledger-table article.confirmed .confirm-state {
        background: #edf7f0;
        color: #245f3d;
      }

      .ledger-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }

      .step-row div {
        display: flex;
        flex-direction: column;
      }

      .step-row code {
        margin-top: 4px;
        color: #666;
        font-size: 11px;
      }

      .deviation-form {
        padding: 16px 0;
        border-bottom: 1px solid #e3e3e3;
      }

      .deviation-actions {
        grid-template-columns: 1fr auto;
        align-items: end;
      }

      .deviation-list article {
        padding: 12px 0;
        border-bottom: 1px solid #e6e6e6;
      }

      .deviation-list article > div {
        display: flex;
        justify-content: space-between;
      }

      .deviation-list p {
        margin: 7px 0;
      }

      .deviation-list span {
        color: #8e260f;
        font-size: 11px;
      }

      .approval-flow {
        margin: 18px 0 0;
        padding: 0;
        list-style: none;
      }

      .approval-flow li {
        display: grid;
        grid-template-columns: 32px 1fr;
        gap: 12px;
        padding: 12px 0;
        border-bottom: 1px solid #e6e6e6;
      }

      .flow-index {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border: 1px solid #9d9d9d;
        color: #555;
      }

      .approval-flow li.approved .flow-index {
        border-color: #4b8d65;
        background: #e8f5ed;
        color: #245f3d;
      }

      .approval-flow li.rejected .flow-index {
        border-color: #c21d00;
        background: #fbece8;
        color: #8e260f;
      }

      .approval-flow p {
        margin: 5px 0;
        color: #5f5f5f;
      }

      .approval-flow small {
        color: #737373;
      }

      .approval-form {
        padding-top: 16px;
      }

      .approved-message {
        margin: 18px 0 0;
        padding: 16px;
        border-left: 3px solid #4b8d65;
        background: #edf7f0;
        color: #245f3d;
      }

      .freeze-strip {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1px;
        margin-top: 18px;
        background: #d7d7d7;
      }

      .freeze-strip div {
        display: flex;
        flex-direction: column;
        padding: 14px;
        background: #fafafa;
      }

      .freeze-strip span {
        color: #666;
        font-size: 11px;
      }

      .freeze-strip strong {
        margin-top: 4px;
      }

      .retrospective-note {
        margin-top: 18px;
        padding: 16px;
        background: #f4f6f7;
      }

      .retrospective-note p {
        margin: 6px 0 0;
        color: #5f5f5f;
      }

      .empty {
        color: #737373;
      }

      .not-found {
        margin-top: 50px;
        padding: 48px;
        text-align: center;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      @media (max-width: 1100px) {
        .detail-heading,
        .content-grid {
          grid-template-columns: 1fr;
        }

        .span-2 {
          grid-column: auto;
        }
      }

      @media (max-width: 700px) {
        .heading-meta,
        .facts,
        .edit-grid,
        .freeze-strip {
          grid-template-columns: 1fr;
        }

        .heading-meta div {
          border-left: 0;
          border-top: 1px solid #e1e1e1;
        }

        .resource-table article,
        .step-row,
        .ledger-table article {
          grid-template-columns: 1fr;
        }

        .ledger-actions,
        .ledger-toolbar {
          justify-content: flex-start;
        }

        .tab-nav {
          padding-bottom: 4px;
        }
      }
    `,
  ],
})
export class ChangeDetailComponent {
  private readonly store = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly service = inject(ChangeRequestService);
  private readonly changeId = this.route.snapshot.paramMap.get('id') ?? '';

  readonly changes = this.store.selectSignal(selectAllChanges);
  readonly change = computed(() => this.changes().find((item) => item.id === this.changeId));
  readonly selectedTab = signal<DetailTab>('overview');
  readonly editing = signal(false);
  readonly draft = signal<ChangeRequest | null>(null);
  readonly approver = signal('');
  readonly approvalComment = signal('');
  readonly deviationText = signal('');
  readonly deviationDecision = signal<DeviationRecord['decision']>('continue');
  readonly activeSource = signal<ExecutionSource>('console');
  readonly saveError = this.store.selectSignal(selectChangesError);

  readonly tabs: Array<{ id: DetailTab; label: string }> = [
    { id: 'overview', label: '方案概览' },
    { id: 'dependency', label: '依赖关系' },
    { id: 'window', label: '窗口甘特' },
    { id: 'execution', label: '执行记录' },
    { id: 'approval', label: '审批会签' },
    { id: 'audit', label: '审计复盘' },
  ];

  readonly issues = computed(() => {
    const item = this.change();
    return item ? validateChange(item, this.changes()) : [];
  });

  readonly hasBlockers = computed(() =>
    this.issues().some((issue) => issue.severity === 'blocker'),
  );

  readonly projection = computed<ProjectedExecution | null>(() => {
    const item = this.change();
    return item ? projectExecution(item, item.executionLedger) : null;
  });

  readonly effectiveChange = computed<ChangeRequest | null>(() => {
    const item = this.change();
    return item ? materializeProjectedChange(item, item.executionLedger) : null;
  });

  readonly ledgerEvents = computed<ExecutionEvent[]>(() => {
    const ledger = this.change()?.executionLedger;
    return ledger
      ? [...ledger.events].sort(
          (left, right) =>
            new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
        )
      : [];
  });

  readonly pendingStage = computed<ApprovalStage | null>(() => {
    const item = this.change();
    if (!item || !['submitted', 'rejected'].includes(item.status)) {
      return null;
    }
    const rejected = item.approvals.find((approval) => approval.state === 'rejected');
    if (rejected) {
      return rejected.stage;
    }
    return item.approvals.find((approval) => approval.state === 'pending')?.stage ?? null;
  });

  beginEdit(): void {
    const item = this.change();
    if (!item) {
      return;
    }
    this.draft.set(structuredClone(item));
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.draft.set(null);
  }

  updateDraft<K extends keyof ChangeRequest>(key: K, value: ChangeRequest[K]): void {
    this.draft.update((draft) => (draft ? { ...draft, [key]: value } : draft));
  }

  updateDraftWindow(key: 'start' | 'end', value: string): void {
    this.draft.update((draft) =>
      draft ? { ...draft, window: { ...draft.window, [key]: value } } : draft,
    );
  }

  updateObservation(value: string | number): void {
    this.draft.update((draft) =>
      draft
        ? {
            ...draft,
            window: { ...draft.window, observationWindowMinutes: Number(value) || 0 },
          }
        : draft,
    );
  }

  saveEdit(): void {
    const draft = this.draft();
    if (!draft) {
      return;
    }
    this.store.dispatch(ChangeRequestActions.updateChange({ change: draft }));
    this.editing.set(false);
    this.draft.set(null);
  }

  submitForReview(): void {
    if (!this.hasBlockers()) {
      this.store.dispatch(ChangeRequestActions.submitForReview({ id: this.changeId }));
    }
  }

  approve(stage: ApprovalStage): void {
    const approver = this.approver().trim() || '当前用户';
    const comment = this.approvalComment().trim() || '同意按方案执行。';
    this.store.dispatch(
      ChangeRequestActions.approveStage({
        id: this.changeId,
        stage,
        approver,
        comment,
      }),
    );
    this.clearApprovalForm();
  }

  reject(stage: ApprovalStage): void {
    const approver = this.approver().trim() || '当前用户';
    const comment = this.approvalComment().trim();
    if (!comment) {
      return;
    }
    this.store.dispatch(
      ChangeRequestActions.rejectStage({
        id: this.changeId,
        stage,
        approver,
        comment,
      }),
    );
    this.clearApprovalForm();
  }

  startExecution(): void {
    this.store.dispatch(
      ChangeRequestActions.startExecution({ id: this.changeId, source: this.activeSource() }),
    );
  }

  toggleStep(stepId: string): void {
    this.store.dispatch(
      ChangeRequestActions.toggleStep({
        id: this.changeId,
        stepId,
        source: this.activeSource(),
      }),
    );
  }

  reportCounterpartStep(event: ExecutionEvent, opposite: boolean, clickEvent: Event): void {
    clickEvent.preventDefault();
    if (!event.stepId) {
      return;
    }
    this.store.dispatch(
      ChangeRequestActions.toggleStep({
        id: this.changeId,
        stepId: event.stepId,
        source: this.counterpart(event.source),
        occurredAt: event.occurredAt,
        oppositeToEventId: opposite ? event.id : undefined,
      }),
    );
    this.reconcile();
  }

  recordDeviation(): void {
    const description = this.deviationText().trim();
    if (!description) {
      return;
    }
    const deviation: DeviationRecord = {
      id: `dev-${Date.now()}`,
      recordedAt: new Date().toISOString(),
      owner: this.change()?.onCall[0] ?? '当前用户',
      description,
      decision: this.deviationDecision(),
    };
    this.store.dispatch(
      ChangeRequestActions.recordDeviation({
        id: this.changeId,
        deviation,
        source: this.activeSource(),
      }),
    );
    this.deviationText.set('');
  }

  counterDeviation(event: ExecutionEvent): void {
    if (!event.deviation) {
      return;
    }
    this.store.dispatch(
      ChangeRequestActions.recordDeviation({
        id: this.changeId,
        deviation: {
          ...event.deviation,
          recordedAt: event.occurredAt,
        },
        source: this.counterpart(event.source),
      }),
    );
    this.reconcile();
  }

  reconcile(): void {
    this.store.dispatch(ChangeRequestActions.reconcileLedger({ id: this.changeId }));
  }

  resolveConflict(eventId: string, _preferCurrent: boolean): void {
    this.store.dispatch(
      ChangeRequestActions.resolveLedgerConflict({
        id: this.changeId,
        eventId,
        note: '值守复核后采纳该端记录，另一事件保留但不再参与投影。',
      }),
    );
  }

  reconfirm(eventId: string): void {
    this.store.dispatch(ChangeRequestActions.reconfirmLedgerEvent({ id: this.changeId, eventId }));
  }

  simulateWriteFailure(): void {
    this.service.failNextSave();
    this.reconcile();
  }

  retrySave(): void {
    this.store.dispatch(ChangeRequestActions.retrySaveChanges());
  }

  counterTerminal(type: ExecutionEvent['type'], opposite = false): void {
    if (type !== 'execution-completed' && type !== 'execution-rollback') {
      return;
    }
    const target = this.ledgerEvents().find(
      (event) => event.type === type && event.status === 'unconfirmed',
    );
    if (!target) {
      return;
    }
    const sameResult = type === 'execution-completed' ? 'completed' : 'rolled_back';
    const result = opposite
      ? sameResult === 'completed'
        ? 'rolled_back'
        : 'completed'
      : sameResult;
    this.store.dispatch(
      ChangeRequestActions.completeExecution({
        id: this.changeId,
        result,
        note: opposite
          ? '对端给出相反最终结论，进入冲突复核。'
          : String(target.payload['note'] ?? '对端补报相同最终结论'),
        source: this.counterpart(target.source),
        occurredAt: target.occurredAt,
      }),
    );
    this.reconcile();
  }

  complete(result: 'completed' | 'rolled_back'): void {
    const projected = this.projection();
    if (!projected || !this.canFinish(projected, result)) {
      return;
    }
    const note =
      result === 'completed'
        ? '观察窗口内指标稳定，两端合并账本判定变更完成。'
        : '发现不可接受影响，两端合并账本判定按方案完成回滚。';
    this.store.dispatch(
      ChangeRequestActions.completeExecution({
        id: this.changeId,
        result,
        note,
        source: this.activeSource(),
      }),
    );
  }

  exportRetrospective(): void {
    const item = this.effectiveChange();
    if (!item) {
      return;
    }
    const blob = new Blob([this.service.exportRetrospective(item)], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${item.id}-retrospective.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  stepsBy(change: ChangeRequest): ChangeStep[] {
    const order: ChangeStep['phase'][] = ['prepare', 'execute', 'verify', 'rollback'];
    return [...change.steps].sort((left, right) => {
      const phase = order.indexOf(left.phase) - order.indexOf(right.phase);
      return phase || left.id.localeCompare(right.id);
    });
  }

  completedSteps(change: ChangeRequest): number {
    return change.steps.filter((step) => step.completed).length;
  }

  pendingStepEvents(stepId: string): ExecutionEvent[] {
    return (
      this.change()?.executionLedger?.events.filter(
        (event) =>
          event.stepId === stepId &&
          ['unconfirmed', 'conflict', 'invalidated'].includes(event.status),
      ) ?? []
    );
  }

  canFinish(projected: ProjectedExecution, result: 'completed' | 'rolled_back'): boolean {
    const operationalStepsComplete =
      result === 'rolled_back' ||
      (projected.steps.length > 0 &&
        projected.steps
          .filter((step) => step.phase !== 'rollback')
          .every((step) => step.completed));
    return (
      projected.status === 'executing' &&
      operationalStepsComplete &&
      projected.openConflictCount === 0 &&
      projected.invalidatedCount === 0 &&
      projected.unconfirmedCount === 0
    );
  }

  setSource(source: ExecutionSource | string): void {
    this.activeSource.set(source === 'datacenter' ? 'datacenter' : 'console');
  }

  counterpart(source: ExecutionSource): ExecutionSource {
    return source === 'console' ? 'datacenter' : 'console';
  }

  isTerminal(type: ExecutionEvent['type']): boolean {
    return type === 'execution-completed' || type === 'execution-rollback';
  }

  sourceLabel(source: ExecutionSource): string {
    return EXECUTION_SOURCE_LABELS[source];
  }

  eventLabel(type: ExecutionEvent['type']): string {
    return EXECUTION_EVENT_LABELS[type];
  }

  confirmationLabel(status: ExecutionEvent['status']): string {
    return EVENT_CONFIRMATION_LABELS[status];
  }

  statusLabel(status: ChangeRequest['status']): string {
    return STATUS_LABELS[status];
  }

  riskLabel(risk: ChangeRequest['risk']): string {
    return RISK_LABELS[risk];
  }

  resourceLabel(type: ChangeRequest['resources'][number]['type']): string {
    return RESOURCE_LABELS[type];
  }

  stageLabel(stage: ApprovalStage): string {
    return STAGE_LABELS[stage];
  }

  phaseLabel(phase: ChangeStep['phase']): string {
    return PHASE_LABELS[phase];
  }

  approvalStateText(state: ChangeRequest['approvals'][number]['state']): string {
    return {
      pending: '等待签署',
      approved: '已批准',
      rejected: '已退回',
      frozen: '已冻结',
    }[state];
  }

  approvalGate(): string {
    const item = this.change();
    if (!item) {
      return '-';
    }
    if (item.status === 'approved') {
      return '已批准，等待执行';
    }
    if (['executing', 'completed', 'rolled_back'].includes(item.status)) {
      return '审批已冻结';
    }
    return '方案草稿';
  }

  decisionLabel(decision: DeviationRecord['decision']): string {
    return {
      continue: '继续观察',
      pause: '暂停执行',
      rollback: '立即回滚',
    }[decision];
  }

  private clearApprovalForm(): void {
    this.approver.set('');
    this.approvalComment.set('');
  }
}
