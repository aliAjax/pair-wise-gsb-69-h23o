import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, Observable, of, tap } from 'rxjs';
import { ChangeRequest } from '../models/change-request.model';
import {
  ChangeLedger,
  EVENT_STATUS_LABELS,
  SITE_LABELS,
  describeEvent,
  projectLedger,
} from '../models/execution-ledger.model';

const STORAGE_KEY = 'pair-wise-gsb-69-changes';

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
  private readonly http = inject(HttpClient);

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

  save(changes: ChangeRequest[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changes));
  }

  exportRetrospective(change: ChangeRequest, ledger?: ChangeLedger): string {
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
      '',
      '## 审计轨迹',
      ...change.audit.map(
        (item) => `- ${item.timestamp} ${item.actor} ${item.action}：${item.detail}`,
      ),
    ];

    if (ledger) {
      const projection = projectLedger(ledger);
      lines.push(
        '',
        `## 双端事件账本（v${ledger.version} / 纪元 ${ledger.epoch}）`,
        '',
        `最终结论：${projection.outcome ?? (projection.conclusionBlocked ? '冲突待复核，未成立' : '执行中')}`,
        '',
        ...ledger.events.map(
          (event) =>
            `- v${event.version} 步骤${event.stepNo ?? '-'} ${event.occurredAt} ` +
            `[${SITE_LABELS[event.site]}] ${describeEvent(event)}（${EVENT_STATUS_LABELS[event.status]}）`,
        ),
      );
      if (ledger.conflicts.length) {
        lines.push(
          '',
          '### 冲突复核',
          ...ledger.conflicts.map(
            (conflict) =>
              `- ${conflict.reconciliationKey} ${conflict.status}` +
              (conflict.reviewedBy ? `，复核人：${conflict.reviewedBy}` : '') +
              (conflict.acceptedEventId ? `，采纳：${conflict.acceptedEventId}` : ''),
          ),
        );
      }
    }

    return lines.join('\n');
  }
}
