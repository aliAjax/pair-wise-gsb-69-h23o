import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, Observable, of, tap, throwError } from 'rxjs';
import { ChangeRequest } from '../models/change-request.model';
import {
  EVENT_CONFIRMATION_LABELS,
  EXECUTION_EVENT_LABELS,
  EXECUTION_SOURCE_LABELS,
} from '../models/execution-ledger';

const STORAGE_KEY = 'pair-wise-gsb-69-changes';

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
  private readonly http = inject(HttpClient);
  private simulateNextFailure = false;

  load(): Observable<ChangeRequest[]> {
    const localValue = localStorage.getItem(STORAGE_KEY);
    if (localValue) {
      try {
        return of(JSON.parse(localValue) as ChangeRequest[]);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

    return this.http.get<ChangeRequest[]>('/mock/change-requests.json').pipe(
      tap((changes) => this.save(changes)),
      catchError((error: unknown) => {
        console.error('Failed to load change requests', error);
        return of([]);
      }),
    );
  }

  save(changes: ChangeRequest[]): Observable<void> {
    if (this.simulateNextFailure) {
      this.simulateNextFailure = false;
      return throwError(() => new Error('模拟断网：事件暂存失败，保留本地待重试状态'));
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(changes));
      return of(undefined);
    } catch (error: unknown) {
      return throwError(() =>
        error instanceof Error ? error : new Error('事件账本写入失败，可在网络恢复后续作重试'),
      );
    }
  }

  failNextSave(): void {
    this.simulateNextFailure = true;
  }

  exportRetrospective(change: ChangeRequest): string {
    const lines = [
      `# ${change.id} ${change.title} 复盘记录`,
      '',
      `状态：${change.status}`,
      `负责人：${change.owner}`,
      `窗口：${change.window.start} - ${change.window.end}`,
      `风险等级：${change.risk}`,
      '',
      '## 执行偏离',
      ...(change.deviations.length
        ? change.deviations.map(
            (item) => `- ${item.recordedAt} ${item.owner} [${item.decision}] ${item.description}`,
          )
        : ['- 无']),
      ...(change.executionLedger
        ? [
            '',
            '## 事件账本',
            `- 变更版本：${change.executionLedger.basis.revision}`,
            `- 窗口依据：${change.executionLedger.basis.windowHash}`,
            `- 资源依据：${change.executionLedger.basis.resourceHash}`,
            `- 步骤依据：${change.executionLedger.basis.stepHash}`,
            ...change.executionLedger.events.map(
              (event) =>
                `- ${event.occurredAt} [${EVENT_CONFIRMATION_LABELS[event.status]}] ${EXECUTION_SOURCE_LABELS[event.source]} v${event.changeVersion}${
                  event.stepNo ? ` 步骤${event.stepNo}` : ''
                } ${EXECUTION_EVENT_LABELS[event.type]}`,
            ),
            '',
            '## 冲突复核',
            ...(change.executionLedger.conflicts.length
              ? change.executionLedger.conflicts.map(
                  (conflict) =>
                    `- ${conflict.id}：${conflict.reason} / ${
                      conflict.status === 'resolved'
                        ? `已采纳 ${conflict.winnerEventId}（${conflict.resolutionNote}）`
                        : '待复核'
                    }`,
                )
              : ['- 无']),
          ]
        : []),
      '',
      '## 审计轨迹',
      ...change.audit.map(
        (item) => `- ${item.timestamp} ${item.actor} ${item.action}：${item.detail}`,
      ),
    ];
    return lines.join('\n');
  }
}
