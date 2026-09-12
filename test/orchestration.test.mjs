import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function harness(service) {
  let entry, View, cursor = 0;
  const state = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useRef: value => ({ current: value }),
    useEffect() {},
    useSyncExternalStore: (_, snapshot) => snapshot(),
  };
  new Function('window', 'document', source)(
    { __ModuleLoader__: { load: value => { entry = value; } } },
    { querySelector: () => ({}) }, // Styles are covered by the real browser preview.
  );
  const client = entry.factory(name => { assert.equal(name, 'react'); return react; });
  client.apply({ get: name => name === 'sessions' ? service : undefined, slots: {
    inject(name, thunk) { if (name === 'conversation.view') View = thunk().component; },
    register: (options, component) => ({ options, component }),
  } });
  return { api: client.__orchestration, render(props) { cursor = 0; return View(props); } };
}
function collect(tree, predicate) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (predicate(node)) found.push(node);
    node.children?.forEach(visit);
  }
  visit(tree);
  return found;
}
const text = tree => JSON.stringify(tree);
const base = Date.now() - 60000;
function fixture() {
  const nodes = new Map();
  const add = (name, args, result, time) => nodes.set(String(nodes.size), { kind: 'tool-call', data: { root: {
    kind: 'tool-result', call: { name, argsRaw: JSON.stringify(args) }, content: [{ type: 'text', text: JSON.stringify(result) }], time,
  } } });
  add('task_spawn', {}, { ok: true, sessionId: 'task-a', title: '0912｜优化｜布局重构', team: 'A' }, base);
  add('task_spawn', {}, { ok: true, sessionId: 'task-b', title: '0912｜检查｜记录核对', team: 'B' }, base + 1);
  add('task_send', { sessionId: 'task-a', mode: 'steer' }, { ok: false, delivered: false }, base + 2);
  const chat = { order: [...nodes.keys()], nodes };
  const byId = { root: { title: '总控', running: true }, 'task-a': { title: '0912｜优化｜布局重构', running: true, projectionValues: { todos: [{ status: 'completed' }, { status: 'pending' }] } } };
  return { sessionId: 'root', useChat: selector => selector(chat), useSessions: selector => selector({ byId }), useSession: selector => selector({ hasMore: true }) };
}
test('selection stays in overview; explicit open targets the selected task; owner changes reset selection', () => {
  const opened = [], h = harness({ open: id => opened.push(id) }), props = fixture();
  let tree = h.render(props);
  const cards = collect(tree, el => el.props['data-role'] === 'child');
  assert.equal(cards[0].props['aria-pressed'], true);
  cards[1].props.onClick();
  assert.deepEqual(opened, []);
  tree = h.render(props);
  assert.equal(collect(tree, el => el.props['data-role'] === 'child')[1].props['aria-pressed'], true);
  const inspector = collect(tree, el => el.type === 'aside')[0];
  assert.match(text(inspector), /记录核对/);
  assert.match(text(inspector), /状态未知/);
  assert.doesNotMatch(text(inspector), /离线/);
  collect(tree, el => el.props.className === 'orchViewPrimary')[0].props.onClick();
  assert.deepEqual(opened, ['task-b']);
  tree = h.render({ ...props, sessionId: 'other-root' });
  assert.equal(collect(tree, el => el.props['data-role'] === 'child')[0].props['aria-pressed'], true);
});
test('many tasks wrap inside measured bounds, with no overlaps; ordering and layout are deterministic', () => {
  const { api } = harness();
  const children = Array.from({ length: 40 }, (_, i) => ({ sessionId: `task-${i}`, title: 'long title', time: i, team: i < 20 ? 'B' : 'A' }));
  for (const width of [216, 320, 652, 808, 1200]) {
    const layout = api.layoutTopology({ children }, width);
    assert.deepEqual(layout, api.layoutTopology({ children: children.slice().reverse() }, width));
    assert.equal(layout.rows[0].team, 'B');
    const boxes = Object.values(layout.nodes);
    for (const box of boxes) { assert.ok(box.x >= 0); assert.ok(box.x + box.width <= width + 0.01); }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `overlap at width ${width}`);
    }
  }
});
test('family projection expands the current lineage and keeps nested parent links separate from sibling teams',()=>{
  const {api}=harness();
  const family={rootSessionId:'root',nodes:[
    {sessionId:'root',parentSessionId:null,familyDepth:0},
    {sessionId:'a',parentSessionId:'root',familyDepth:1,team:'same',time:1},
    {sessionId:'b',parentSessionId:'root',familyDepth:1,team:'same',time:2},
    {sessionId:'c',parentSessionId:'a',familyDepth:2,team:'same',time:3},
    {sessionId:'d',parentSessionId:'b',familyDepth:2,team:'same',time:4},
  ]};
  const projected=api.orchFamilyProjection(family,new Set(['root','a','c']));
  assert.deepEqual(projected.children.map(c=>c.sessionId),['a','b','c']);
  assert.equal(projected.edges.find(e=>e.to==='c').from,'a');
  const layout=api.layoutTopology(projected,1000);
  assert.ok(layout.nodes.c.y>layout.nodes.a.y+layout.nodes.a.height);
  assert.equal(layout.rows.find(r=>r.ids.includes('c')).parentId,'a');
  const collapsed=api.orchFamilyProjection(family,new Set(['root']));
  assert.deepEqual(collapsed.children.map(c=>c.sessionId),['a','b']);
});
test('repeated relations aggregate while failed delivery stays inspectable without a success edge', () => {
  const h = harness(), props = fixture();
  const extraction = h.api.extractOrchestration(props.useChat(x => x));
  assert.equal(extraction.edges.find(e => e.kind === 'send').delivered, false);
  const repeats = Array.from({ length: 100 }, (_, i) => ({ kind: 'send', from: 'coordinator', to: 'task-a', time: i, delivered: true }));
  const groups = h.api.orchGroupRelations({ ...extraction, edges: [...extraction.edges, ...repeats] });
  assert.equal(groups.filter(e => e.kind === 'send').length, 1);
  assert.equal(groups.find(e => e.kind === 'send').count, 100);
  const tree = h.render(props);
  assert.match(text(tree), /指令未送达/);
  assert.equal(collect(tree, el => el.props['data-relation'] && el.props.className.includes('EdgeSend')).length, 0);
});
test('uneven teams of 1 / 2 / 2 share a compact band without reserving empty card slots', () => {
  const {api} = harness();
  const children = ['task-bridge','host-upgrade','host-upgrade','reader-page','reader-page'].map((team,i) => ({team,sessionId:`task-${i}`,time:i}));
  for (const width of [808,1042]) {
    const layout = api.layoutTopology({children},width);
    assert.equal(new Set(layout.rows.map(row => row.y)).size,1,'all three small teams fit on one band');
    assert.equal(layout.rows[0].width,layout.nodes['task-0'].width+24,'one task occupies one card slot');
    assert.equal(layout.rows[1].width,2*layout.nodes['task-1'].width+36,'two tasks occupy two card slots');
    assert.ok(layout.size.height < 550,'diagram height leaves room for the composer at desktop sizes');
  }
});
test('empty states distinguish partial history, fully loaded history, and missing service', () => {
  const h = harness(), props = fixture(), empty = { ...props, useChat: selector => selector({ order: [], nodes: new Map() }) };
  assert.match(text(h.render(empty)), /当前记录中未找到子任务/);
  assert.match(text(h.render({ ...empty, useSession: selector => selector({ hasMore: false }) })), /本会话尚未派发子任务/);
  assert.match(text(h.render({ ...empty, useChat: () => { throw new Error('fixture error'); } })), /暂时无法读取任务关系/);
});
test('history requests use the bound session face, expose loading, and recover after rejection', async () => {
  const ids = []; let reject;
  const h = harness({ binding: id => { ids.push(id); return { session: { loadOlder: () => new Promise((_, no) => { reject = no; }) } }; } });
  const props = fixture();
  collect(h.render(props), el => el.props.className === 'orchViewLink')[0].props.onClick();
  assert.deepEqual(ids, ['root']);
  assert.equal(collect(h.render(props), el => el.props.className === 'orchViewLink')[0].props.disabled, true);
  reject(new Error('fixture paging failure'));
  await new Promise(resolve => setImmediate(resolve));
  const tree = h.render(props);
  assert.equal(collect(tree, el => el.props.className === 'orchViewLink')[0].props.disabled, false);
  assert.match(text(tree), /fixture paging failure/);
});
