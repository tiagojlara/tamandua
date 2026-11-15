import test from 'node:test';
import assert from 'node:assert/strict';
import { stripToolInventory, historyToMessages } from '../src/client/tamanduaMessages.mjs';

const activity = [
  { tool: 'get_net_worth' }, { tool: 'get_summary' }, { tool: 'list_cash_balances' },
  { tool: 'get_cash_flow_summary' }, { tool: 'list_cash_flow_transactions' },
];

test('a trailing tool inventory is removed from stored answers', () => {
  const content = 'The loan is affordable.\n\nFrom get_net_worth, get_summary, list_cash_balances and get_cash_flow_summary (2026-09, 2026-10, 2026-11) and list_cash_flow_transactions on 2026-11-15.';
  assert.equal(stripToolInventory(content, activity), 'The loan is affordable.');
});

test('a real sentence that happens to start with From is kept', () => {
  const content = 'The loan is affordable.\n\nFrom get_summary and list_cash_balances, the cash buffer is about two months of spending.';
  assert.equal(stripToolInventory(content, activity), content);
});

test('one-tool source lines and empty activity are left alone', () => {
  const content = 'Answer.\n\nFrom get_summary on 2026-11-08.';
  assert.equal(stripToolInventory(content, [{ tool: 'get_summary' }]), content);
  assert.equal(stripToolInventory(content, []), content);
});

test('historyToMessages applies the cleanup to assistant rows only', () => {
  const rows = [
    { id: 1, role: 'user', content: 'question' },
    { id: 2, role: 'assistant', content: 'Answer.\n\nFrom get_summary and list_cash_flow_transactions on 2026-11-15.', toolActivity: activity.filter((entry) => ['get_summary', 'list_cash_flow_transactions'].includes(entry.tool)) },
  ];
  const messages = historyToMessages(rows);
  assert.equal(messages[0].content, 'question');
  assert.equal(messages[1].content, 'Answer.');
});
