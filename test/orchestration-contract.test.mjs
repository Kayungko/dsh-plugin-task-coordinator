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
  // 0.26.7 bisect ruling: the sticky zero-width sentinel (0.26.4-0.26.6) never
  // rendered the drawer on the real host — three geometry variants failed — so
  // the layer returns to the last known-good 0.26.3 shape: a full-coverage
  // absolute layer over the (position:relative) shell, which also gives the
  // inspector a full-width containing block for its percentage width.
  assert.match(source, /\.orchDrawerLayer\{position:absolute;inset:0/);
  const layerRule = source.match(/\.orchDrawerLayer\{([^}]+)\}/)?.[1] || '';
  const inspectorRule = source.match(/\.orchViewInspector\{position:absolute;([^}]+)\}/)?.[1] || '';
  assert.match(layerRule, /position:absolute;inset:0/);
  assert.doesNotMatch(layerRule, /position:sticky/);
  assert.doesNotMatch(source, /\.orchDrawerLayer\{position:fixed/);
  assert.match(inspectorRule, /top:16px;right:16px/);
  assert.match(inspectorRule, /width:min\(380px,calc\(100% - 32px\)\)/);
  assert.match(inspectorRule, /max-height:calc\(var\(--dsh-conversation-viewport-height,100dvh\) - 32px\)/);
  assert.match(inspectorRule, /overflow-y:auto/);
  // 0.26.7 bottom-blank fix: root and shell stretch to the host-published
  // conversation viewport height (percentage fallback keeps old hosts a no-op).
  const rootRule = source.match(/\.orchViewRoot\{padding-bottom:24px;([^}]+)\}/)?.[1] || '';
  const shellRule = source.match(/\.orchViewShell\{([^}]+)\}/)?.[1] || '';
  assert.match(rootRule, /min-height:var\(--dsh-conversation-viewport-height,100%\)/);
  assert.match(shellRule, /min-height:var\(--dsh-conversation-viewport-height,100%\)/);
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
