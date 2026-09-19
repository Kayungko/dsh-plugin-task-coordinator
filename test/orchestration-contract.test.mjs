import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('P2-1 orchReadFamily consumes four fetch response states', async () => {
  assert.match(source, /async function orchReadFamily/);
  assert.match(source, /value = await response\.json\(\)/);
  assert.match(source, /value\?\.ok !== true/);
  assert.match(source, /family-service-unavailable/);
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /controller\.signal\.aborted \|\| requestId !== historyRequest\.current/);
});

test('P2-2 history uses latest cursor fallback when projections are absent', () => {
  const family = readFileSync(new URL('../family.mjs', import.meta.url), 'utf8');
  assert.match(family, /parent\.projections\?\.asOfSeq \?\? -1/);
});

test('P2-3 list-size refresh is debounced while explicit refresh remains immediate', () => {
  assert.match(source, /setTimeout\(\(\) => setListSizeStable\(listSize\), 1500\)/);
  assert.match(source, /\[sessionId, refresh, tick, listSizeStable\]/);
  assert.match(source, /\[historyKey, refresh\]/);
});

test('drawer contract covers toggle, Escape, close, non-modal and cleared selection', () => {
  assert.match(source, /setDrawerOpen\(!closing\)/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /orchViewInspectorClose/);
  assert.match(source, /position:absolute/);
  assert.match(source, /drawerOpen \?/);
  assert.match(source, /setSelection\(null\)/);
});

test('supervision layout keeps canvas and drawer as sibling layers with bounded scrolling', () => {
  assert.match(source, /className: "orchViewWorkspace orchViewShell"/);
  assert.match(source, /className: "orchCanvasScroll"/);
  assert.match(source, /className: "orchDrawerLayer"/);
  assert.match(source, /width:min\(380px,calc\(100% - 32px\)\)/);
  assert.match(source, /max-height:calc\(100% - 32px\)/);
  assert.match(source, /overflow-y:auto/);
});

test('canvas blank click closes only at the canvas boundary; cards and drawer stop it', () => {
  assert.match(source, /className: "orchViewCanvas"[^}]*onPointerDown/);
  assert.match(source, /onClick: closeFromCanvas/);
  assert.match(source, /setDrawerOpen\(false\);\s*setSelection\(null\)/);
  assert.match(source, /target\?\.closest\?\.\("button,\[data-role='child'\]/);
  assert.match(source, /onClick: event => event\.stopPropagation\(\)/);
  assert.match(source, /Math\.hypot/);
});

test('orchestration mount hides host composer and resize handles with cleanup', () => {
  assert.match(source, /\[data-composer-seat\]/);
  assert.match(source, /\[data-width-handle\]/);
  assert.match(source, /data-orchestration-hidden/);
  assert.match(source, /removeAttribute\("data-orchestration-hidden"\)/);
});
