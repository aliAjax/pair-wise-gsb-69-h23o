import { Injectable } from '@angular/core';
import {
  ExecutionEvent,
  LedgerWorkspace,
  createEmptyLedgerWorkspace,
} from '../models/execution-ledger.model';

const LEDGER_STORAGE_KEY = 'pair-wise-gsb-69-ledger-workspace';

export interface DeliveryAttempt {
  ok: boolean;
  error?: string;
}

/**
 * 事件账本的本地持久化与“跨端传输”模拟。
 *
 * 真实部署中控制台与机房值守各有自己的存储并经网络同步；这里用同一个
 * 浏览器工作区表示合并账本，用在线状态和故障注入开关模拟断网与写入失败：
 * - 端离线或开启写入故障时投递失败，事件留在发件箱等待重试；
 * - 重新在线后对发件箱逐条重试并续作，事件幂等标识保证不会重复入账。
 */
@Injectable({ providedIn: 'root' })
export class ExecutionLedgerService {
  loadWorkspace(): LedgerWorkspace {
    const value = localStorage.getItem(LEDGER_STORAGE_KEY);
    if (!value) {
      return createEmptyLedgerWorkspace();
    }
    try {
      const parsed = JSON.parse(value) as Partial<LedgerWorkspace>;
      const base = createEmptyLedgerWorkspace();
      return {
        ...base,
        ...parsed,
        online: { ...base.online, ...(parsed.online ?? {}) },
        ledgers: parsed.ledgers ?? {},
      };
    } catch {
      localStorage.removeItem(LEDGER_STORAGE_KEY);
      return createEmptyLedgerWorkspace();
    }
  }

  saveWorkspace(workspace: LedgerWorkspace): void {
    localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(workspace));
  }

  /** 判断某个端当前能否把事件写入合并账本。 */
  attemptDelivery(workspace: LedgerWorkspace, event: ExecutionEvent): DeliveryAttempt {
    if (workspace.injectFailure) {
      return { ok: false, error: '写入失败：存储通道故障，事件已留在发件箱' };
    }
    if (!workspace.online[event.site]) {
      return { ok: false, error: '写入失败：该端与对端网络中断' };
    }
    return { ok: true };
  }
}
