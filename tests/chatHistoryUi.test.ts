import { describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  App: class {},
  Editor: class {},
  FileSystemAdapter: class {},
  ItemView: class {},
  MarkdownRenderer: { render: vi.fn() },
  MarkdownView: class {},
  Modal: class {},
  Notice: class {},
  Setting: class {},
  TFile: class {},
  WorkspaceLeaf: class {},
  requestUrl: vi.fn(),
  setIcon: vi.fn(),
}));

import type { ConversationSummary } from '../src/storage/vaultStore';
import type { ChatMessage } from '../src/types';
import { ChatContextOverflowError } from '../src/chat';
import {
  ConversationUiOperationGate,
  getConversationArchiveBlockReason,
  loadPersistedMessagesThroughAnchor,
  mergeConversationMessages,
  mergeConversationSummaries,
  prepareNewConversationContext,
  resolveHistoryConversationIcon,
} from '../src/ui/chatView';

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    agentId: 'codex',
  };
}

function summary(id: string, revision: number): ConversationSummary {
  return {
    id,
    title: id,
    agentId: 'codex',
    createdAt: 1,
    updatedAt: revision,
    revision,
    messageCount: revision,
    turnCount: 0,
    archivedAt: null,
    lastMessagePreview: '',
  };
}

describe('chat history UI merge helpers', () => {
  test('preflights the complete first request against the selected model capacity', () => {
    expect(prepareNewConversationContext({
      currentPrompt: 'a'.repeat(700_000),
      systemPrompt: 'Keep the answer concise.',
      modelContextTokens: 1_000_000,
      modelOutputReserveTokens: 128_000,
      reservedInputTokens: 8_000,
    }).mode).toBe('new-conversation');

    expect(() => prepareNewConversationContext({
      currentPrompt: '中'.repeat(40_000),
      systemPrompt: 'Keep the answer concise.',
      modelContextTokens: 32_000,
      modelOutputReserveTokens: 8_000,
      reservedInputTokens: 8_000,
    })).toThrow(ChatContextOverflowError);
  });

  test('keeps loaded earlier messages when a later live snapshot only contains the recent window', () => {
    const loaded = [message('m1', 'old'), message('m2', 'checkpoint-old'), message('m3', 'recent')];
    const live = [message('m2', 'checkpoint-new'), message('m3', 'recent'), message('m4', 'streaming')];

    expect(mergeConversationMessages(loaded, live).map(item => [item.id, item.content])).toEqual([
      ['m1', 'old'],
      ['m2', 'checkpoint-new'],
      ['m3', 'recent'],
      ['m4', 'streaming'],
    ]);
  });

  test('deduplicates overlapping message pages without changing chronological order', () => {
    const earlier = [message('m1', 'one'), message('m2', 'old-two')];
    const current = [message('m2', 'two'), message('m3', 'three')];

    expect(mergeConversationMessages(earlier, current).map(item => item.content)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  test('loads only enough older pages to restore an explicitly saved message anchor', async () => {
    const loadPage = vi.fn(async (beforeSequence: number) => {
      if (beforeSequence === 101) {
        return {
          messages: [message('m51', '51'), message('m100', '100')].map((item, index) => ({
            sequence: 51 + index * 49,
            message: item,
          })),
          nextBeforeSequence: 51,
        };
      }
      return {
        messages: [message('m1', '1'), message('m50', '50')].map((item, index) => ({
          sequence: 1 + index * 49,
          message: item,
        })),
        nextBeforeSequence: null,
      };
    });

    const restored = await loadPersistedMessagesThroughAnchor({
      conversationId: 'conversation',
      anchorMessageId: 'm51',
      persistedMessages: [message('m101', '101'), message('m120', '120')],
      nextBeforeSequence: 101,
      loadPage,
    });

    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(restored.anchorFound).toBe(true);
    expect(restored.nextBeforeSequence).toBe(51);
    expect(restored.persistedMessages.map(item => item.id)).toEqual([
      'm51',
      'm100',
      'm101',
      'm120',
    ]);
  });

  test('stops safely when a malformed older-page cursor repeats', async () => {
    const loadPage = vi.fn(async () => ({
      messages: [],
      nextBeforeSequence: 101,
    }));

    const restored = await loadPersistedMessagesThroughAnchor({
      conversationId: 'conversation',
      anchorMessageId: 'missing',
      persistedMessages: [message('m101', '101')],
      nextBeforeSequence: 101,
      loadPage,
    });

    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(restored.anchorFound).toBe(false);
    expect(restored.nextBeforeSequence).toBeNull();
  });

  test('deduplicates summary page boundaries and refreshes the overlapping row', () => {
    const merged = mergeConversationSummaries(
      [summary('c1', 1), summary('c2', 1)],
      [summary('c2', 2), summary('c3', 1)],
    );

    expect(merged.map(item => `${item.id}:${item.revision}`)).toEqual(['c1:1', 'c2:2', 'c3:1']);
  });

  test('blocks archive for the selected or running conversation, but never blocks restore', () => {
    expect(getConversationArchiveBlockReason(summary('current', 1), 'current', false))
      .toContain('不能归档');
    expect(getConversationArchiveBlockReason(summary('running', 1), 'other', true))
      .toContain('仍在后台运行');
    expect(getConversationArchiveBlockReason(summary('idle', 1), 'other', false)).toBeNull();
    expect(getConversationArchiveBlockReason(
      { ...summary('archived', 1), archivedAt: 10 },
      'archived',
      true,
    )).toBeNull();
  });

  test('gives every running conversation a loader before current or agent-specific icons', () => {
    expect(resolveHistoryConversationIcon({
      agentId: 'codex',
      isArchived: false,
      isCurrent: true,
      isRunning: true,
    })).toBe('loader-circle');
    expect(resolveHistoryConversationIcon({
      agentId: 'claude',
      isArchived: false,
      isCurrent: false,
      isRunning: true,
    })).toBe('loader-circle');
    expect(resolveHistoryConversationIcon({
      agentId: 'codex',
      isArchived: false,
      isCurrent: true,
      isRunning: false,
    })).toBe('check');
    expect(resolveHistoryConversationIcon({
      agentId: 'claude',
      isArchived: false,
      isCurrent: false,
      isRunning: false,
    })).toBe('bot');
  });

  test('gates preparation per conversation without imposing a cross-conversation limit', () => {
    const gate = new ConversationUiOperationGate();

    expect(gate.tryBeginPreparation('first')).toBe(true);
    expect(gate.tryBeginPreparation('first')).toBe(false);
    expect(gate.tryBeginPreparation('second')).toBe(true);
    gate.finishPreparation('first');
    expect(gate.tryBeginPreparation('first')).toBe(true);
  });

  test('serializes history operations only for the same conversation', async () => {
    const gate = new ConversationUiOperationGate();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = gate.run('same', async () => {
      events.push('same:first:start');
      await firstHold;
      events.push('same:first:end');
    });
    const second = gate.run('same', async () => {
      events.push('same:second');
    });
    const parallel = gate.run('other', async () => {
      events.push('other');
    });
    await parallel;
    expect(events).toEqual(['same:first:start', 'other']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'same:first:start',
      'other',
      'same:first:end',
      'same:second',
    ]);
  });

  test('marks an archive as pending synchronously so open can fail closed', () => {
    const gate = new ConversationUiOperationGate();
    expect(gate.markArchivePending('conversation')).toBe(true);
    expect(gate.isArchivePending('conversation')).toBe(true);
    expect(gate.markArchivePending('conversation')).toBe(false);
    gate.clearArchivePending('conversation');
    expect(gate.isArchivePending('conversation')).toBe(false);
  });
});
