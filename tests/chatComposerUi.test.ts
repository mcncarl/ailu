import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const chatViewSource = fs.readFileSync(
  fileURLToPath(new URL('../src/ui/chatView.ts', import.meta.url)),
  'utf8',
);
const stylesheet = fs.readFileSync(
  fileURLToPath(new URL('../styles.css', import.meta.url)),
  'utf8',
);

describe('chat composer UI contract', () => {
  it('uses the Ailu product name in the empty-state invitation', () => {
    expect(chatViewSource).toContain('从一篇笔记开始，或直接交给 Ailu。');
    expect(chatViewSource).not.toContain('从一篇笔记开始，或直接交给 Agent。');
  });

  it('uses the Ailu-specific placeholder with a lighter theme-aware color', () => {
    expect(chatViewSource).toContain("placeholder: '告诉Ailu你要做的事'");
    expect(stylesheet).toMatch(
      /\.ailu-input::placeholder\s*\{[\s\S]*?color:\s*color-mix\(in srgb, var\(--text-muted\) 68%, transparent\);[\s\S]*?opacity:\s*1;/,
    );
  });

  it('removes the ESC hint without removing the Escape cancellation behavior', () => {
    expect(chatViewSource).not.toContain('按下ESC取消当前任务');
    expect(chatViewSource).not.toContain('cancelHintEl');
    expect(stylesheet).not.toContain('.ailu-cancel-hint');
    expect(chatViewSource).toMatch(
      /if \(event\.key === 'Escape'\) \{[\s\S]{0,220}?this\.stopCurrentConversation\(\);/,
    );
  });

  it('keeps the header quiet without removing composer runtime controls', () => {
    expect(chatViewSource).not.toContain("cls: 'ailu-runtime-status'");
    expect(chatViewSource).not.toContain('CC Switch · ${this.ccSwitchLabel(ccSwitchStatus)}');
    expect(stylesheet).not.toContain('.ailu-runtime-status');
    expect(chatViewSource).toContain('this.renderAgentSelector(toolbarLeft)');
    expect(chatViewSource).toContain('this.renderConfigSourceSelector(this.agentControlsEl)');
    expect(chatViewSource).toContain('this.renderModelSelector(this.agentControlsEl)');
    expect(chatViewSource).toContain('this.renderEffortSelector(this.agentControlsEl)');
  });

  it('deduplicates persistence backpressure notices and capability-gates Agent Memory', () => {
    expect(chatViewSource).toContain('error instanceof ChatPersistenceBackpressureError');
    expect(chatViewSource).toContain('this.persistenceBackpressureNotice?.hide()');
    expect(chatViewSource).toContain('now - this.lastPersistenceBackpressureNoticeAt < 8_000');
    expect(chatViewSource).toContain('&& this.deps.isMemoryRuntimeReady()');
    expect(chatViewSource).not.toContain('new Notice(`Agent Memory 已禁用：');
  });

  it('passes the selected model capacity and complete request overhead into context preparation', () => {
    expect(chatViewSource).toContain('resolveModelContextCapacity({');
    expect(chatViewSource).toContain('modelContextTokens: modelContextCapacity.contextWindowTokens');
    expect(chatViewSource).toContain('modelOutputReserveTokens: modelContextCapacity.outputReserveTokens');
    expect(chatViewSource).toContain('requestOverheadText: [settings.systemPrompt]');
    expect(chatViewSource).toContain('DEFAULT_NATIVE_RUNTIME_OVERHEAD_TOKENS');
    expect(chatViewSource).toContain('prepareNewConversationContext({');
    expect(chatViewSource).not.toContain('已压缩较早对话，完整聊天记录仍然保留。');
  });
});
