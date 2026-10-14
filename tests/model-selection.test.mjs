import assert from 'node:assert/strict';
import test from 'node:test';
import { createOps } from '../src/gemini-ops.js';

class FixtureLabel {
  constructor(text = '') { this.textContent = text; this.innerText = text; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 120, height: 24 }; }
}

class FixtureMenuItem {
  constructor(document, label, { submenu = false, onClick, visibleWhen, selected = false } = {}) {
    this.document = document;
    this.label = label;
    this.submenu = submenu;
    this.onClick = onClick;
    this.visibleWhen = visibleWhen || (() => true);
    this.selected = selected;
    this.tagName = 'GEM-MENU-ITEM';
  }

  getBoundingClientRect() {
    const visible = this.document.menuOpen && this.visibleWhen();
    return { x: 0, y: 0, width: visible ? 180 : 0, height: visible ? 32 : 0 };
  }

  getAttribute(name) {
    if (name === 'aria-checked' || name === 'aria-selected') return this.selected ? 'true' : 'false';
    return null;
  }

  hasAttribute(name) { return this.selected && ['checked', 'selected'].includes(name); }

  querySelector(selector) {
    if (selector === 'span.label') return new FixtureLabel(this.label);
    if (selector === '.trailing-container' && this.submenu) return { children: [{}] };
    return null;
  }

  click() { this.onClick?.(this.label); }
}

class FixtureDocument {
  constructor({ model = '', thinking = '', labels = [], selectedLabel = '', buttonLabelOnly = false, buttonLabels = {} } = {}) {
    this.model = new FixtureLabel(model);
    this.thinking = thinking ? new FixtureLabel(thinking) : null;
    this.buttonModelLabel = model;
    this.buttonLabelOnly = buttonLabelOnly;
    this.buttonLabels = buttonLabels;
    this.selectedLabel = selectedLabel || (labels.includes(model) ? model : '');
    this.menuOpen = false;
    this.submenuOpen = false;
    this.menuItems = [];
    this.labels = labels;
    this.setModelOptions(labels);
  }

  setModelOptions(labels) {
    const items = labels.map(label => new FixtureMenuItem(this, label, {
      visibleWhen: () => !this.submenuOpen,
      selected: label === this.selectedLabel,
      onClick: value => {
        this.selectedLabel = value;
        for (const item of items) item.selected = item.label === value;
        const buttonValue = this.buttonLabels[value] || (this.buttonLabelOnly ? null : value);
        if (buttonValue) {
          this.model.textContent = buttonValue;
          this.model.innerText = buttonValue;
        }
        this.menuOpen = false;
        this.submenuOpen = false;
      },
    }));
    this.menuItems = items;
  }

  setThinkingOptions(labels, { selected = '', closeOnSelect = false } = {}) {
    this.submenuOpen = false;
    this.selectedThinkingLabel = selected;
    const entry = new FixtureMenuItem(this, 'Thinking level', {
      submenu: true,
      visibleWhen: () => !this.submenuOpen,
      onClick: () => {
        this.submenuOpen = true;
        const options = labels.map(label => new FixtureMenuItem(this, label, {
          visibleWhen: () => this.submenuOpen,
          selected: label === this.selectedThinkingLabel,
          onClick: value => {
            this.selectedThinkingLabel = value;
            for (const option of options) option.selected = option.label === value;
            if (this.thinking) this.thinking = new FixtureLabel(value.split(/[（(]/)[0].trim());
            if (closeOnSelect) {
              this.menuOpen = false;
              this.submenuOpen = false;
            }
          },
        }));
        this.menuItems = [entry, ...options];
      },
    });
    this.menuItems = [entry];
  }

  querySelector(selector) {
    if (selector === '.picker-primary-text'
      || selector === '[data-test-id="logo-pill-label-container"] span'
      || selector === 'div.logo-pill-label-container span') return this.model;
    if (selector === '.picker-secondary-text') return this.thinking;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === 'gem-menu-item') return this.menuItems;
    if (selector === '.picker-primary-text'
      || selector === '[data-test-id="logo-pill-label-container"] span'
      || selector === 'div.logo-pill-label-container span') return [this.model];
    if (selector === '.picker-secondary-text') return this.thinking ? [this.thinking] : [];
    return [];
  }
}

function makeOps(options = {}) {
  const original = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
  };
  const document = new FixtureDocument(options);
  globalThis.document = document;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  const page = { evaluate: (fn, ...args) => fn(...args) };
  const ops = createOps(page);
  ops._openModelMenu = async () => { document.menuOpen = true; return { ok: true }; };
  ops._closeModelMenu = async () => { document.menuOpen = false; document.submenuOpen = false; return { ok: true }; };
  return {
    ops,
    document,
    restore() {
      globalThis.document = original.document;
      globalThis.getComputedStyle = original.getComputedStyle;
    },
  };
}

test('current model labels normalize version and family without conflating Flash-Lite', async () => {
  const cases = [
    ['3.5 Flash-Lite（极速回答）', 'flash-lite', '3.5'],
    ['3.8 Flash（全方位帮助）', 'flash', '3.8'],
    ['3.1 Pro（高级推理）', 'pro', '3.1'],
    ['4 Argon（复杂任务）', 'argon', '4'],
  ];
  for (const [raw, model, version] of cases) {
    const fixture = makeOps({ model });
    try {
      fixture.document.model.textContent = raw;
      const result = await fixture.ops.getCurrentModel();
      assert.equal(result.ok, true);
      assert.equal(result.model, model);
      assert.equal(result.version, version);
      assert.equal(result.raw, raw);
    } finally {
      fixture.restore();
    }
  }
});

test('latest dynamically picks the highest numeric version (4 Argon wins over 3.8 Flash)', async () => {
  const fixture = makeOps({
    model: '3.1 Pro（高级推理）',
    labels: [
      '3.8 Flash（全方位帮助）',
      '3.5 Flash-Lite（极速回答）',
      '4 Argon（复杂任务）',
      '3.1 Pro（高级推理）',
    ],
  });
  try {
    const result = await fixture.ops.switchToModel('latest');
    assert.equal(result.ok, true);
    assert.equal(result.model, 'argon');
    assert.equal(result.version, '4');
    assert.match(fixture.document.model.textContent, /^4 Argon/);
  } finally {
    fixture.restore();
  }
});

test('available model discovery preserves visible labels and canonical families', async () => {
  const fixture = makeOps({ labels: [
    '3.5 Flash-Lite（极速回答）',
    '3.8 Flash（全方位帮助）',
    '3.1 Pro（高级推理）',
    '4 Argon（复杂任务）',
  ] });
  fixture.document.menuOpen = true;
  try {
    const models = await fixture.ops.getAvailableModels();
    assert.deepEqual(models.map(({ model, version }) => [model, version]), [
      ['flash-lite', '3.5'],
      ['flash', '3.8'],
      ['pro', '3.1'],
      ['argon', '4'],
    ]);
  } finally {
    fixture.restore();
  }
});

test('latest follows newly added versions instead of a fixed model-family ranking', async () => {
  const fixture = makeOps({
    model: '4 Argon（复杂任务）',
    labels: [
      '4 Argon（复杂任务）',
      '3.8 Flash（全方位帮助）',
      '4.2 Nova（新模型）',
    ],
  });
  try {
    const result = await fixture.ops.ensureLatestModel();
    assert.equal(result.ok, true);
    assert.equal(result.model, 'unknown');
    assert.equal(fixture.document.model.textContent, '4.2 Nova（新模型）');
  } finally {
    fixture.restore();
  }
});

test('latest confirms a version from the checked menu label when the button only says Argon', async () => {
  const fixture = makeOps({
    model: 'Argon',
    buttonLabelOnly: true,
    selectedLabel: '4 Argon（复杂任务）',
    labels: ['3.8 Flash（全方位帮助）', '4 Argon（复杂任务）'],
  });
  try {
    const result = await fixture.ops.switchToModel('latest');
    assert.equal(result.ok, true);
    assert.equal(result.switched, false);
    assert.equal(result.version, '4');
    assert.equal(result.selected, '4 Argon（复杂任务）');
    assert.equal(fixture.document.model.textContent, 'Argon');
    assert.equal(fixture.document.menuOpen, false);
  } finally {
    fixture.restore();
  }
});

test('latest verifies a newly selected version from checked menu state when button omits version', async () => {
  const fixture = makeOps({
    model: '3.1 Pro（高级推理）',
    buttonLabelOnly: true,
    buttonLabels: { '4 Argon（复杂任务）': 'Argon' },
    selectedLabel: '3.1 Pro（高级推理）',
    labels: ['3.1 Pro（高级推理）', '4 Argon（复杂任务）'],
  });
  try {
    const result = await fixture.ops.switchToModel('latest');
    assert.equal(result.ok, true);
    assert.equal(result.switched, true);
    assert.equal(result.model, 'argon');
    assert.equal(result.version, '4');
    assert.equal(result.selected, '4 Argon（复杂任务）');
    assert.equal(fixture.document.model.textContent, 'Argon');
    assert.equal(fixture.document.menuOpen, false);
  } finally {
    fixture.restore();
  }
});

test('explicit Flash selects Flash and not the Flash-Lite sibling', async () => {
  const fixture = makeOps({
    model: '3.1 Pro（高级推理）',
    labels: ['3.5 Flash-Lite（极速回答）', '3.8 Flash（全方位帮助）', '4 Argon（复杂任务）'],
  });
  try {
    const result = await fixture.ops.switchToModel('flash');
    assert.equal(result.ok, true);
    assert.equal(result.model, 'flash');
    assert.equal(result.version, '3.8');
    assert.match(fixture.document.model.textContent, /^3.8 Flash/);
  } finally {
    fixture.restore();
  }
});

test('thinking labels use the main label, not contradictory descriptive text', async () => {
  const fixture = makeOps({ model: '4 Argon（复杂任务）', thinking: '低点（快速高效）' });
  try {
    const result = await fixture.ops.getThinkingDepth();
    assert.equal(result.ok, true);
    assert.equal(result.level, 'low');
    assert.equal(result.legacyLevel, null);
  } finally {
    fixture.restore();
  }
});

test('Argon can be set to high by matching 高点 instead of using submenu position', async () => {
  const fixture = makeOps({ model: '4 Argon（复杂任务）' });
  fixture.document.setThinkingOptions([
    '低点（快速高效）',
    '中等（平衡）',
    '高点（超级详尽）',
  ]);
  try {
    const result = await fixture.ops.setThinkingDepth('high');
    assert.equal(result.ok, true);
    assert.equal(result.level, 'high');
    assert.equal(fixture.document.selectedThinkingLabel, '高点（超级详尽）');
  } finally {
    fixture.restore();
  }
});

test('thinking depth is read from submenu checkmark when the picker has no secondary text', async () => {
  const fixture = makeOps({ model: '4 Argon（复杂任务）' });
  fixture.document.setThinkingOptions([
    '低点（快速高效）',
    '中等（平衡）',
    '高点（超级详尽）',
  ], { selected: '高点（超级详尽）' });
  try {
    const result = await fixture.ops.getThinkingDepth();
    assert.equal(result.ok, true);
    assert.equal(result.level, 'high');
    assert.equal(result.raw, '高点（超级详尽）');
    assert.equal(fixture.document.menuOpen, false, 'the helper closes the menu it opened');
  } finally {
    fixture.restore();
  }
});

test('low submenu checkmark is not misread from the 高 in 快速高效 description', async () => {
  const fixture = makeOps({ model: '4 Argon（复杂任务）' });
  fixture.document.setThinkingOptions([
    '低点（快速高效）',
    '中等（平衡）',
    '高点（超级详尽）',
  ], { selected: '低点（快速高效）' });
  try {
    const result = await fixture.ops.getThinkingDepth();
    assert.equal(result.ok, true);
    assert.equal(result.level, 'low');
    assert.equal(result.raw, '低点（快速高效）');
  } finally {
    fixture.restore();
  }
});

test('setThinkingDepth verifies checked submenu state when picker has no secondary text', async () => {
  const fixture = makeOps({ model: '4 Argon（复杂任务）' });
  fixture.document.setThinkingOptions([
    '低点（快速高效）',
    '中等（平衡）',
    '高点（超级详尽）',
  ], { selected: '低点（快速高效）', closeOnSelect: true });
  try {
    const result = await fixture.ops.setThinkingDepth('high');
    assert.equal(result.ok, true);
    assert.equal(result.level, 'high');
    assert.equal(fixture.document.thinking, null, 'no cached secondary label is provided');
    assert.equal(fixture.document.menuOpen, false);
  } finally {
    fixture.restore();
  }
});

test('missing Pro secondary text is not inferred as medium', async () => {
  const fixture = makeOps({ model: '3.1 Pro（高级推理）' });
  try {
    const result = await fixture.ops.getThinkingDepth();
    assert.equal(result.ok, false);
    assert.notEqual(result.level, 'medium');
  } finally {
    fixture.restore();
  }
});

test('legacy standard/extended remain accepted and map to medium/high', async () => {
  const fixture = makeOps({ model: '3.1 Pro（高级推理）', thinking: 'standard' });
  fixture.document.setThinkingOptions(['standard', 'extended']);
  try {
    const current = await fixture.ops.getThinkingDepth();
    assert.equal(current.level, 'medium');
    assert.equal(current.legacyLevel, 'standard');

    const result = await fixture.ops.setThinkingDepth('extended');
    assert.equal(result.ok, true);
    assert.equal(result.level, 'high');
    assert.equal(result.legacyLevel, 'extended');
    assert.equal(fixture.document.thinking.textContent, 'extended');
  } finally {
    fixture.restore();
  }
});

test('missing thinking option and unsupported model fail explicitly', async () => {
  const fixture = makeOps({ model: '4 Argon（复杂任务）', thinking: '中等' });
  fixture.document.setThinkingOptions(['中等（平衡）', '高点（超级详尽）']);
  try {
    const unavailable = await fixture.ops.setThinkingDepth('low');
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.error, 'thinking_level_not_supported');

    fixture.document.model.textContent = '3.8 Flash（全方位帮助）';
    const unsupported = await fixture.ops.setThinkingDepth('high');
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error, 'thinking_depth_unsupported');
  } finally {
    fixture.restore();
  }
});

test('unavailable Argon does not silently select another model', async () => {
  const fixture = makeOps({
    model: '3.1 Pro（高级推理）',
    labels: ['3.1 Pro（高级推理）', '3.8 Flash（全方位帮助）'],
  });
  try {
    const result = await fixture.ops.switchToModel('argon');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'model_option_argon_not_found');
    assert.equal(fixture.document.model.textContent, '3.1 Pro（高级推理）');
  } finally {
    fixture.restore();
  }
});
