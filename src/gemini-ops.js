/**
 * gemini-ops.js — Gemini 操作高层 API
 *
 * 职责：
 *   基于 operator.js 的底层原子操作，编排 Gemini 特定的业务流程。
 *   全部通过 CDP 实现，不往页面注入任何对象。
 */
import { createOperator } from './operator.js';
import { sleep } from './util.js';
import config from './config.js';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve as pathResolve, normalize as pathNormalize } from 'node:path';
import { removeWatermarkFromFile, removeWatermarkFromDataUrl } from './watermark-remover.js';
import { findNewResponse, responseFingerprint } from './gemini-response.js';
import { createDownloadLifecycle, createDownloadWorkspace } from './gemini-download.js';

// ── Gemini 页面元素选择器 ──
const SELECTORS = {
  promptInput: [
    'div.ql-editor[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][aria-label*="Gemini"]',
    '[contenteditable="true"][data-placeholder*="Gemini"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  /** 输入区底部按钮的父容器（包裹麦克风 + 发送按钮） */
  actionBtnWrapper: [
    'div.input-buttons-wrapper-bottom',
  ],
  /** 麦克风容器 — class 带 hidden 时隐藏（表示输入框有文字） */
  micContainer: [
    'div.mic-button-container',
  ],
  /** 发送按钮容器 — class 带 visible 时可见（输入框有文字），否则隐藏 */
  sendBtnContainer: [
    'div.send-button-container',
  ],
  /** 发送按钮本身 — class 末尾 submit（可发送）或 stop（加载中） */
  sendBtn: [
    'gem-icon-button.send-button button',                // 新 UI：gem-icon-button 内部的实际 button
    'button[aria-label="发送"]',                          // 新 UI：aria-label 兜底
    '.send-button-container button.send-button',         // 旧 UI
    '.send-button-container button',                     // 旧 UI 兜底
  ],
  newChatBtn: [
    '[data-test-id="new-chat-button"] a',
    '[data-test-id="new-chat-button"]',
    'a[aria-label="发起新对话"]',
    'a[aria-label*="new chat" i]',
  ],
  modelBtn: [
    '[data-test-id="bard-mode-menu-button"]',      // 测试专属属性（新旧 UI 通用）
    'button[aria-label="打开模式选择器"]',            // 中文 aria-label
    'button[aria-label*="mode selector" i]',        // 英文 aria-label 兜底
    'button.mat-mdc-menu-trigger.input-area-switch',// class 组合兜底
  ],
  /** 模型标签文本容器（读取当前模型族与版本，如 "3.1 Pro" / "4 Argon"） */
  modelLabel: [
    '.picker-primary-text',                                              // 新 UI：直接定位 innerText
    '[data-test-id="logo-pill-label-container"] span',                   // 旧 UI：最内层 span
    'div.logo-pill-label-container span',                                // 旧 UI 兜底
  ],
  /** 当前思考等级副标签 */
  thinkingDepthLabel: [
    '.picker-secondary-text',
  ],
  /** 模型选择面板容器（点击 modelBtn 后弹出的菜单） */
  modelMenu: [
    '[data-test-id="gem-mode-menu"]',                                    // 新 UI：data-test-id
    'gem-menu[role="menu"]',                                              // 新 UI：标签兜底
  ],
  /** 模型选择面板内的所有菜单项（包括模型选项 + 思考深度入口） */
  modelMenuItems: [
    '[data-test-id="gem-mode-menu"] gem-menu-item',
    'gem-menu[role="menu"] gem-menu-item',
  ],
  tempChatBtn: [
    '[data-test-id="temp-chat-button"]',          // 最稳定：测试专属属性
    'button[aria-label="临时对话"]',                // 中文 aria-label
    'button[aria-label*="temporary" i]',           // 英文 aria-label 兜底
    'button.temp-chat-button',                     // class 名兜底
    'button[mattooltip="临时对话"]',                // Angular Material tooltip 属性
  ],
  sidebarContainer: [
    '[data-test-id="overflow-container"]',         // 测试专属属性
    'div.overflow-container',                      // class 兜底
  ],
  /** 加号面板按钮（点击后弹出上传菜单） */
  uploadPanelBtn: [
    'gem-icon-button[arialabel="上传和工具"] button',                  // 新 UI：gem-icon-button 包裹，arialabel 属性
    'button[aria-label="上传和工具"][aria-haspopup="menu"]',           // 新 UI：button 上的 aria-label
    'button[aria-label="上传和工具"]',                                  // 新 UI 兜底
    'button.upload-card-button[aria-haspopup="menu"]',                 // 旧 UI：class + aria 组合
    'button[aria-controls="upload-file-u"]',                           // 旧 UI：aria-controls 兜底
    'button.upload-card-button',                                        // 旧 UI：class 兜底
  ],
  /** 上传文件选项（加号面板展开后的"上传文件"按钮） */
  uploadFileBtn: [
    '[data-test-id="uploader-images-files-button-advanced"]',          // 测试专属属性（新旧 UI 通用）
    'images-files-uploader[data-test-id]',                             // 新 UI：标签 + data-test-id
    'images-files-uploader',                                            // 标签名兜底
  ],
  /** 图片分享按钮（hover 图片后出现） */
  shareImageBtn: [
    'button[data-test-id="share-button"]',
    'button[aria-label*="Share image" i]',
    'button[aria-label*="分享图片" i]',
  ],
  /** 下载完整尺寸图片按钮（hover 图片后出现的工具栏按钮） */
  downloadFullSizeBtn: [
    'download-generated-image-button',                            // 新 UI：自定义标签元素
    'download-generated-image-button button',                     // 新 UI：自定义元素内的实际 button
    'button[data-test-id="download-generated-image-button"]',     // 旧 UI：data-test-id
    'button[data-test-id="download-enhanced-image-button"]',      // 旧 UI：另一种命名
    'button:has(mat-icon[fonticon="download"])',                  // 兜底：包含 download 图标的 button（i18n 安全）
  ],
  /** 分享弹窗容器 */
  shareDialog: [
    'mat-dialog-container',
    '[role="dialog"]',
    '.cdk-dialog-container',
    '.mat-mdc-dialog-container',
  ],
  /** 分享弹窗中的公开链接 */
  shareDialogLink: [
    'a[data-test-id="created-share-link"]',
    'a.link-url',
  ],
  /** 分享弹窗中的复制按钮 */
  shareDialogCopyBtn: [
    'button[data-test-id="copy-link"]',
    'button[aria-label*="Copy public link" i]',
    'button[aria-label*="Link copied" i]',
    'button[aria-label*="复制公开链接" i]',
    'button[aria-label*="已复制链接" i]',
  ],
  /** 分享弹窗关闭按钮 */
  shareDialogCloseBtn: [
    'button[data-test-id="close-dialog"]',
    'button[aria-label="Close"]',
    'button[aria-label="关闭"]',
  ],
};

function parseModelLabel(raw = '') {
  const label = String(raw).trim();
  const mainLabel = label.split(/[（(]/, 1)[0].trim();
  const lower = mainLabel.replace(/flash\s+lite/ig, 'flash-lite').toLowerCase();
  let model = 'unknown';
  if (/\bargon\b/i.test(lower)) model = 'argon';
  else if (/\bpro\b/i.test(lower)) model = 'pro';
  else if (/\bflash-lite\b/i.test(lower)) model = 'flash-lite';
  else if (/\bflash\b/i.test(lower)) model = 'flash';

  const familyToken = model === 'unknown' ? null : model;
  const familyIndex = familyToken ? lower.indexOf(familyToken) : lower.length;
  const versionMatches = familyToken ? [...mainLabel.slice(0, familyIndex).matchAll(/\d+(?:\.\d+)*/g)] : [];
  const version = familyToken
    ? versionMatches.at(-1)?.[0] || null
    : mainLabel.match(/^\s*(?:gemini\s+)?(\d+(?:\.\d+)*)\b/i)?.[1] || null;
  return { model, version, raw: label };
}

function compareModelVersions(left, right) {
  const a = String(left || '').split('.').map(Number);
  const b = String(right || '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function normalizeModelTarget(target) {
  const text = String(target || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === 'latest' || text === 'newest') return 'latest';
  const aliases = {
    'flash lite': 'flash-lite',
    'flashlite': 'flash-lite',
    'flash_lite': 'flash-lite',
    'gemini pro': 'pro',
    'gemini flash': 'flash',
  };
  return aliases[text] || (['argon', 'pro', 'flash', 'flash-lite'].includes(parseModelLabel(text).model)
    ? parseModelLabel(text).model
    : null);
}

function normalizeThinkingLevel(level) {
  const text = String(level || '').trim().toLowerCase();
  if (['low', '低', '低点'].includes(text)) return 'low';
  if (['medium', '中', '中等', 'standard', '标准'].includes(text)) return 'medium';
  if (['high', '高', '高点', 'extended', '扩展'].includes(text)) return 'high';
  return null;
}

function parseThinkingLabel(raw = '') {
  const text = String(raw).trim().toLowerCase();
  if (/^(?:low|低点|低)(?:$|[\s（(])/i.test(text)) return 'low';
  if (/^(?:medium|mid|standard|中等|中|标准)(?:$|[\s（(])/i.test(text)) return 'medium';
  if (/^(?:high|extended|高点|高|扩展)(?:$|[\s（(])/i.test(text)) return 'high';
  return null;
}

function legacyThinkingLevel(level) {
  return level === 'medium' ? 'standard' : level === 'high' ? 'extended' : null;
}

/**
 * 创建 GeminiOps 操控实例
 * @param {import('puppeteer-core').Page} page
 */
export function createOps(page) {
  const op = createOperator(page);

  return {
    /** 暴露底层 operator，供高级用户直接使用 */
    operator: op,

    /** 暴露选择器定义，方便调试和外部扩展 */
    selectors: SELECTORS,

    /**
     * 探测页面各元素是否就位
     * @returns {Promise<{promptInput: boolean, actionBtnWrapper: boolean, newChatBtn: boolean, modelBtn: boolean, modelLabel: boolean, tempChatBtn: boolean, currentModel: string, status: object, page: object, evidence: object}>}
     */
    async probe() {
      const [promptInput, actionBtnWrapper, newChatBtn, modelBtn, modelLabel, tempChatBtn, status, currentModelResult, pageInfo] = await Promise.all([
        op.locate(SELECTORS.promptInput),
        op.locate(SELECTORS.actionBtnWrapper),
        op.locate(SELECTORS.newChatBtn),
        op.locate(SELECTORS.modelBtn),
        op.locate(SELECTORS.modelLabel),
        op.locate(SELECTORS.tempChatBtn),
        this.getStatus(),
        this.getCurrentModel(),
        op.query((editorSelectors) => {
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect?.();
            if (!rect || rect.width <= 0 || rect.height <= 0) return false;
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
          };
          let editorVisible = false;
          for (const selector of editorSelectors) {
            try {
              if ([...document.querySelectorAll(selector)].some(isVisible)) {
                editorVisible = true;
                break;
              }
            } catch { /* Ignore unsupported selectors. */ }
          }
          const loginControls = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"]')];
          const loginButtonVisible = loginControls.some((el) => {
            if (!isVisible(el)) return false;
            const label = `${el.innerText || el.textContent || ''} ${el.getAttribute?.('aria-label') || ''} ${el.value || ''}`;
            return /sign\s*in|log\s*in|登录|登入/i.test(label);
          });
          const visibleText = (document.body?.innerText || '').replace(/[\t\r\n ]+/g, ' ').trim();
          let safeUrl = '';
          let pageState = 'unsupported_ui';
          try {
            const url = new URL(location.href);
            safeUrl = `${url.origin}${url.pathname}`;
            if (url.hostname === 'accounts.google.com') {
              pageState = /unknownerror/i.test(url.pathname) ? 'auth_error' : 'login_required';
            } else if (loginButtonVisible || /sign\s*in|log\s*in|登录|登入/i.test(visibleText)) {
              pageState = 'login_required';
            } else if (editorVisible) {
              pageState = 'ready';
            } else if (url.hostname === 'gemini.google.com') {
              pageState = 'page_not_ready';
            }
          } catch { /* Invalid or unavailable location. */ }
          return {
            url: safeUrl,
            title: document.title || '',
            visibleText: visibleText.slice(0, 600),
            pageState,
            loginButtonVisible,
            editorVisible,
          };
        }, SELECTORS.promptInput),
      ]);
      return {
        promptInput: promptInput.found,
        actionBtnWrapper: actionBtnWrapper.found,
        newChatBtn: newChatBtn.found,
        modelBtn: modelBtn.found,
        modelLabel: modelLabel.found,
        tempChatBtn: tempChatBtn.found,
        currentModel: currentModelResult.ok ? currentModelResult.raw : '',
        status,
        page: {
          url: pageInfo.url,
          title: pageInfo.title,
          visibleText: pageInfo.visibleText,
          state: pageInfo.pageState,
        },
        evidence: {
          loginButtonVisible: pageInfo.loginButtonVisible,
          editorVisible: pageInfo.editorVisible,
        },
      };
    },

    /**
     * 点击指定按钮
     * @param {'sendBtn'|'newChatBtn'|'modelBtn'|'tempChatBtn'|'uploadPanelBtn'|'uploadFileBtn'} key
     */
    async click(key) {
      const sels = SELECTORS[key];
      if (!sels) {
        return { ok: false, error: `unknown_key: ${key}` };
      }
      return op.click(sels);
    },

    /**
     * 进入临时会话模式
     *
     * 点击页面上的"临时会话"按钮（data-test-id="temp-chat-button"），
     * 然后等待页面完成导航 / 刷新，确保后续操作在临时会话中进行。
     *
     * @param {object} [opts]
     * @param {number} [opts.timeout=15000] - 等待页面导航完成的超时时间（ms）
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async clickTempChat(opts = {}) {
      const { timeout = 15_000 } = opts;

      const clickResult = await this.click('tempChatBtn');
      if (!clickResult.ok) {
        return { ok: false, error: 'temp_chat_btn_not_found' };
      }
      //  给一点时间让 UI 稳定
      await sleep(500);

      console.log('[ops] entered temp chat mode');
      return { ok: true };
    },

    /** 获取当前模型的规范模型族和可见版本标签。 */
    async getCurrentModel() {
      let result;
      try {
        result = await op.query((sels) => {
        let el = null;
        for (const sel of sels) {
          try {
            el = [...document.querySelectorAll(sel)].find((node) => {
              const rect = node.getBoundingClientRect?.();
              if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
              const style = getComputedStyle(node);
              return style.display !== 'none' && style.visibility !== 'hidden';
            }) || null;
          } catch { /* skip */ }
          if (el) break;
        }
        return el ? { raw: (el.textContent || '').trim() } : { error: 'model_label_not_found' };
        }, SELECTORS.modelLabel);
      } catch (error) {
        return { ok: false, model: 'unknown', version: null, raw: '', error: 'model_label_query_failed', detail: error.message || String(error) };
      }
      if (result.error) return { ok: false, model: 'unknown', version: null, raw: '', error: result.error };
      return { ok: true, ...parseModelLabel(result.raw) };
    },

    /** Read model labels currently rendered in the open model menu. */
    async getAvailableModels() {
      const labels = await op.query(() => [...document.querySelectorAll('gem-menu-item')]
        .filter(item => {
          const rect = item.getBoundingClientRect?.();
          if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
          const style = getComputedStyle(item);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map(item => item.querySelector('span.label')?.textContent?.trim() || '')
        .filter(Boolean));
      return labels.map(parseModelLabel).filter(item => item.version || item.model !== 'unknown');
    },

    /** Read the currently checked full model label from the open model menu. */
    async _getSelectedModelMenuLabels() {
      let menuOpen = await op.query(() => [...document.querySelectorAll('gem-menu-item')].some(item => {
        const rect = item.getBoundingClientRect?.();
        if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
        const style = getComputedStyle(item);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }));
      let openedMenu = false;
      if (!menuOpen) {
        const opened = await this._openModelMenu();
        if (!opened.ok) return { ok: false, labels: [], error: opened.error };
        openedMenu = true;
      }
      try {
        const labels = await op.query(() => [...document.querySelectorAll('gem-menu-item')]
          .filter(item => {
            const rect = item.getBoundingClientRect?.();
            if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
            const style = getComputedStyle(item);
            return style.display !== 'none' && style.visibility !== 'hidden';
          })
          .filter(item => item.getAttribute?.('aria-checked') === 'true'
            || item.getAttribute?.('aria-selected') === 'true'
            || item.hasAttribute?.('checked') || item.hasAttribute?.('selected')
            || /\b(selected|checked|active)\b/i.test(String(item.className || ''))
            || !!item.querySelector?.('mat-icon[fonticon="check"],mat-icon[data-mat-icon-name="check"],[data-test-id*="check"],.checkmark,.check-icon,[aria-label*="selected" i],[aria-label*="checked" i]'))
          .map(item => item.querySelector('span.label')?.textContent?.trim() || '')
          .filter(Boolean));
        return { ok: labels.length === 1, labels, error: labels.length === 1 ? undefined : labels.length ? 'model_selection_ambiguous' : 'model_selection_not_checked' };
      } finally {
        if (openedMenu) await this._closeModelMenu();
      }
    },

    /** 获取当前思考等级；旧页面 standard/extended 映射为 medium/high。 */
    async getThinkingDepth() {
      let labelResult;
      let modelResult;
      try {
        [labelResult, modelResult] = await Promise.all([
        op.query((sels) => {
          let el = null;
          for (const sel of sels) {
            try {
              el = [...document.querySelectorAll(sel)].find((node) => {
                const rect = node.getBoundingClientRect?.();
                if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
                const style = getComputedStyle(node);
                return style.display !== 'none' && style.visibility !== 'hidden';
              }) || null;
            } catch { /* skip */ }
            if (el) break;
          }
          return { raw: (el?.textContent || '').trim() };
        }, SELECTORS.thinkingDepthLabel),
        this.getCurrentModel(),
        ]);
      } catch (error) {
        return { ok: false, level: 'unknown', raw: '', error: 'thinking_depth_query_failed', detail: error.message || String(error) };
      }
      const raw = labelResult.raw;
      if (raw) {
        const level = parseThinkingLabel(raw);
        if (level) return { ok: true, level, legacyLevel: legacyThinkingLevel(level), raw };
      }
      let menuResult;
      try {
        menuResult = await this._getThinkingDepthFromMenu();
      } catch (error) {
        return { ok: false, level: 'unknown', raw, error: 'thinking_depth_menu_read_failed', detail: error.message || String(error) };
      }
      if (menuResult.ok) return { ...menuResult, legacyLevel: legacyThinkingLevel(menuResult.level), raw: menuResult.raw };
      return { ok: false, level: 'unknown', raw, error: raw ? 'thinking_depth_unrecognized' : menuResult.error || (modelResult.model === 'argon' ? 'thinking_depth_not_exposed' : 'thinking_depth_unsupported') };
    },

    /** Read the selected thinking option from visible submenu state/checkmarks. */
    async _getThinkingDepthFromMenu() {
      let state = await op.query(() => {
        const visible = (item) => {
          const rect = item.getBoundingClientRect?.();
          if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
          const style = getComputedStyle(item);
          return style.display !== 'none' && style.visibility !== 'hidden';
        };
        return { menuOpen: [...document.querySelectorAll('gem-menu-item')].some(visible) };
      });
      let openedMenu = false;
      let openedSubmenu = false;
      if (!state.menuOpen) {
        const opened = await this._openModelMenu();
        if (!opened.ok) return { ok: false, level: 'unknown', error: opened.error };
        openedMenu = true;
      }

      try {
        state = await op.query(() => {
          const visible = (item) => {
            const rect = item.getBoundingClientRect?.();
            if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
            const style = getComputedStyle(item);
            return style.display !== 'none' && style.visibility !== 'hidden';
          };
          const items = [...document.querySelectorAll('gem-menu-item')].filter(visible);
          const levelOf = (label) => {
            const text = String(label || '').trim().toLowerCase();
            if (/^(?:low|低点|低)(?:$|[\s（(])/i.test(text)) return 'low';
            if (/^(?:medium|mid|standard|中等|中|标准)(?:$|[\s（(])/i.test(text)) return 'medium';
            if (/^(?:high|extended|高点|高|扩展)(?:$|[\s（(])/i.test(text)) return 'high';
            return null;
          };
          const options = items.map(item => ({ item, label: item.querySelector('span.label')?.textContent?.trim() || '' }))
            .filter(option => option.label && levelOf(option.label));
          if (options.length) {
            const isChecked = (item) => {
              if (item.getAttribute?.('aria-checked') === 'true' || item.getAttribute?.('aria-selected') === 'true') return true;
              if (item.hasAttribute?.('checked') || item.hasAttribute?.('selected')) return true;
              if (/\b(selected|checked|active)\b/i.test(String(item.className || ''))) return true;
              return !!item.querySelector?.('mat-icon[fonticon="check"],mat-icon[data-mat-icon-name="check"],[data-test-id*="check"],.checkmark,.check-icon,[aria-label*="selected" i],[aria-label*="checked" i]');
            };
            const selected = options.filter(option => isChecked(option.item));
            if (selected.length !== 1) {
              return { done: true, result: { ok: false, level: 'unknown', error: selected.length ? 'thinking_selection_ambiguous' : 'thinking_selection_not_checked' } };
            }
            return { done: true, result: { ok: true, level: levelOf(selected[0].label), raw: selected[0].label } };
          }
          const entry = items.find(item => {
            const trailing = item.querySelector('.trailing-container');
            const label = item.querySelector('span.label')?.textContent?.trim() || '';
            return trailing?.children?.length > 0 && /thinking|思考|level|等级|reasoning|推理/i.test(label);
          });
          if (entry) {
            entry.click();
            return { done: false, submenuOpened: true };
          }
          return { done: true, result: { ok: false, level: 'unknown', error: 'thinking_depth_unsupported' } };
        });
        if (state.submenuOpened) {
          openedSubmenu = true;
          await sleep(300);
          state = await op.query(() => {
            const visible = (item) => {
              const rect = item.getBoundingClientRect?.();
              if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
              const style = getComputedStyle(item);
              return style.display !== 'none' && style.visibility !== 'hidden';
            };
            const levelOf = (label) => {
              const text = String(label || '').trim().toLowerCase();
              if (/^(?:low|低点|低)(?:$|[\s（(])/i.test(text)) return 'low';
              if (/^(?:medium|mid|standard|中等|中|标准)(?:$|[\s（(])/i.test(text)) return 'medium';
              if (/^(?:high|extended|高点|高|扩展)(?:$|[\s（(])/i.test(text)) return 'high';
              return null;
            };
            const options = [...document.querySelectorAll('gem-menu-item')].filter(visible)
              .map(item => ({ item, label: item.querySelector('span.label')?.textContent?.trim() || '' }))
              .filter(option => option.label && levelOf(option.label));
            const isChecked = (item) => item.getAttribute?.('aria-checked') === 'true'
              || item.getAttribute?.('aria-selected') === 'true'
              || item.hasAttribute?.('checked') || item.hasAttribute?.('selected')
              || /\b(selected|checked|active)\b/i.test(String(item.className || ''))
              || !!item.querySelector?.('mat-icon[fonticon="check"],mat-icon[data-mat-icon-name="check"],[data-test-id*="check"],.checkmark,.check-icon,[aria-label*="selected" i],[aria-label*="checked" i]');
            const selected = options.filter(option => isChecked(option.item));
            if (selected.length !== 1) {
              return { ok: false, level: 'unknown', error: selected.length ? 'thinking_selection_ambiguous' : options.length ? 'thinking_selection_not_checked' : 'thinking_submenu_not_found' };
            }
            return { ok: true, level: levelOf(selected[0].label), raw: selected[0].label };
          });
        } else {
          state = state.result;
        }
      } finally {
        if (openedMenu || openedSubmenu) await this._closeModelMenu();
      }
      return state;
    },

    /**
     * 判断当前模型是否为 Pro
     *
     * @returns {Promise<boolean>}
     */
    async isModelPro() {
      const result = await this.getCurrentModel();
      if (!result.ok) return false;
      return result.model === 'pro';
    },

    /**
     * 打开模型选择菜单（点击 modelBtn）
     * @returns {Promise<{ok: boolean, error?: string}>}
     * @private
     */
    async _openModelMenu() {
      const openResult = await this.click('modelBtn');
      if (!openResult.ok) {
        return { ok: false, error: 'model_menu_open_failed' };
      }
      // 等待菜单动画展开
      await sleep(300);
      return { ok: true };
    },

    /**
     * 关闭模型选择菜单（按 ESC）
     * @private
     */
    async _closeModelMenu() {
      await op.page.keyboard.press('Escape').catch(() => {});
      await sleep(150);
    },

    /** Switch by model family, or dynamically resolve the highest available version for `latest`. */
    async switchToModel(model) {
      try {
      const targetFamily = normalizeModelTarget(model);
      if (!targetFamily) return { ok: false, error: `unknown_model: ${model}` };
      const before = await this.getCurrentModel();
      const previousModel = before.ok ? before.raw : undefined;
      if (targetFamily !== 'latest' && before.ok && before.model === targetFamily) {
        return { ok: true, switched: false, model: before.model, raw: before.raw, version: before.version, previousModel, alreadyTarget: true };
      }
      const openResult = await this._openModelMenu();
      if (!openResult.ok) return { ok: false, error: openResult.error, previousModel };

      const menuEntries = await op.query(() => [...document.querySelectorAll('gem-menu-item')]
        .filter(item => {
          const rect = item.getBoundingClientRect?.();
          if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
          const style = getComputedStyle(item);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map(item => ({
          label: item.querySelector('span.label')?.textContent?.trim() || '',
          selected: item.getAttribute?.('aria-checked') === 'true'
            || item.getAttribute?.('aria-selected') === 'true'
            || item.hasAttribute?.('checked') || item.hasAttribute?.('selected')
            || /\b(selected|checked|active)\b/i.test(String(item.className || ''))
            || !!item.querySelector?.('mat-icon[fonticon="check"],mat-icon[data-mat-icon-name="check"],[data-test-id*="check"],.checkmark,.check-icon,[aria-label*="selected" i],[aria-label*="checked" i]'),
        }))
        .filter(item => item.label));
      const labels = menuEntries.map(entry => entry.label);
      const available = labels.map(label => ({ ...parseModelLabel(label), label }));
      let candidates = available;
      if (targetFamily !== 'latest') candidates = candidates.filter(item => item.model === targetFamily);
      else candidates = candidates.filter(item => item.version);
      if (!candidates.length) {
        await this._closeModelMenu();
        return { ok: false, error: targetFamily === 'latest' ? 'latest_model_not_found' : `model_option_${targetFamily}_not_found`, previousModel };
      }
      candidates.sort((a, b) => compareModelVersions(b.version, a.version));
      const selected = candidates[0];
      if (targetFamily === 'latest' && candidates.length > 1
        && compareModelVersions(candidates[0].version, candidates[1].version) === 0
        && candidates[0].label !== candidates[1].label) {
        await this._closeModelMenu();
        return { ok: false, error: 'latest_model_version_ambiguous', previousModel };
      }
      const alreadyTarget = before.ok && before.model === selected.model
        && (targetFamily !== 'latest' || before.version === selected.version);
      const checkedTarget = targetFamily === 'latest' && before.ok && before.model === selected.model
        && !before.version && menuEntries.filter(entry => entry.selected).length === 1
        && menuEntries.find(entry => entry.selected)?.label === selected.label;
      if (alreadyTarget || checkedTarget) {
        await this._closeModelMenu();
        return { ok: true, switched: false, model: before.model, raw: before.raw, version: selected.version, previousModel, selected: selected.label, alreadyTarget: true };
      }

      const clickResult = await op.query((targetLabel) => {
        for (const item of document.querySelectorAll('gem-menu-item')) {
          const rect = item.getBoundingClientRect?.();
          if (rect && (rect.width <= 0 || rect.height <= 0)) continue;
          const style = getComputedStyle(item);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const label = item.querySelector('span.label')?.textContent?.trim() || '';
          if (label !== targetLabel) continue;
          item.click();
          return { ok: true, label };
        }
        return { ok: false, error: 'model_option_disappeared' };
      }, selected.label);
      if (!clickResult.ok) {
        await this._closeModelMenu();
        return { ok: false, error: clickResult.error, previousModel };
      }

      await sleep(800);
      const after = await this.getCurrentModel();
      const familyConfirmed = after.ok && after.model === selected.model;
      let observedVersion = after.version;
      let menuConfirmed = false;
      if (targetFamily === 'latest' && familyConfirmed && !after.version) {
        const selectedMenu = await this._getSelectedModelMenuLabels();
        const selectedLabels = selectedMenu.ok ? selectedMenu.labels.map(parseModelLabel) : [];
        const checked = selectedMenu.ok && selectedMenu.labels.length === 1
          && selectedMenu.labels[0] === selected.label
          && selectedLabels[0]?.model === selected.model
          && selectedLabels[0]?.version === selected.version;
        menuConfirmed = !!checked;
        if (checked) observedVersion = selectedLabels[0].version;
      }
      const versionConfirmed = targetFamily !== 'latest'
        || (after.ok && (after.version === selected.version || menuConfirmed));
      if (!familyConfirmed || !versionConfirmed) {
        return { ok: false, error: 'model_switch_not_confirmed', model: after.model, raw: after.raw, version: observedVersion, previousModel, selected: selected.label };
      }
      return {
        ok: true,
        switched: true,
        model: after.model,
        raw: after.raw,
        version: observedVersion,
        previousModel,
        selected: selected.label,
      };
      } catch (error) {
        return { ok: false, error: 'model_selection_failed', detail: error.message || String(error) };
      }
    },

    /** Ensure the current model is the latest menu version; explicit opt-in, not the default. */
    async ensureLatestModel() {
      const result = await this.switchToModel('latest');
      return { ok: result.ok, switched: result.switched ?? false, model: result.model, raw: result.raw, error: result.error };
    },

    /**
     * 切换思考等级。主标签匹配 low/medium/high 与旧版 standard/extended。
     */
    async setThinkingDepth(level) {
      try {
      const targetLevel = normalizeThinkingLevel(level);
      if (!targetLevel) return { ok: false, error: `unknown_level: ${level}` };
      const currentModel = await this.getCurrentModel();
      if (!currentModel.ok || !['argon', 'pro'].includes(currentModel.model)) {
        return { ok: false, error: currentModel.ok ? 'thinking_depth_unsupported' : 'current_model_unavailable' };
      }
      const before = await this.getThinkingDepth();
      const previousLevel = before.ok ? before.level : undefined;
      if (before.ok && before.level === targetLevel) {
        return { ok: true, level: targetLevel, legacyLevel: legacyThinkingLevel(targetLevel), switched: false, alreadyTarget: true, previousLevel };
      }
      const openResult = await this._openModelMenu();
      if (!openResult.ok) return { ok: false, error: openResult.error, previousLevel };

      const enterResult = await op.query(() => {
        const items = [...document.querySelectorAll('gem-menu-item')];
        for (const item of items) {
          const rect = item.getBoundingClientRect?.();
          if (rect && (rect.width <= 0 || rect.height <= 0)) continue;
          const style = getComputedStyle(item);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const trailing = item.querySelector('.trailing-container');
          const label = item.querySelector('span.label')?.textContent?.trim() || '';
          if (trailing && trailing.children.length > 0 && /thinking|思考|level|等级|reasoning|推理/i.test(label)) {
            item.click();
            return { ok: true };
          }
        }
        return { ok: false, error: 'thinking_depth_unsupported' };
      });

      if (!enterResult.ok) {
        await this._closeModelMenu();
        return { ok: false, error: enterResult.error, previousLevel };
      }

      await sleep(400);

      const targetLabel = await op.query((wantedLevel) => {
        const matches = (label) => {
          const text = String(label || '').trim().toLowerCase();
          if (/^(?:low|低点|低)(?:$|[\s（(])/i.test(text)) return 'low';
          if (/^(?:medium|mid|standard|中等|中|标准)(?:$|[\s（(])/i.test(text)) return 'medium';
          if (/^(?:high|extended|高点|高|扩展)(?:$|[\s（(])/i.test(text)) return 'high';
          return null;
        };
        const options = [...document.querySelectorAll('gem-menu-item')].filter(item => {
          const rect = item.getBoundingClientRect?.();
          if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
          const style = getComputedStyle(item);
          return style.display !== 'none' && style.visibility !== 'hidden';
        }).map(item => ({
          item,
          label: item.querySelector('span.label')?.textContent?.trim() || '',
        })).filter(option => option.label && matches(option.label) === wantedLevel);
        return options.at(-1)?.label || '';
      }, targetLevel);

      if (!targetLabel) {
        await this._closeModelMenu();
        return { ok: false, error: 'thinking_level_not_supported', previousLevel };
      }
      const pickResult = await op.query((wantedLabel) => {
        for (const item of document.querySelectorAll('gem-menu-item')) {
          const rect = item.getBoundingClientRect?.();
          if (rect && (rect.width <= 0 || rect.height <= 0)) continue;
          const style = getComputedStyle(item);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const label = item.querySelector('span.label')?.textContent?.trim() || '';
          if (label !== wantedLabel) continue;
          item.click();
          return { ok: true, label };
        }
        return { ok: false, error: 'thinking_level_disappeared' };
      }, targetLabel);
      if (!pickResult.ok) {
        await this._closeModelMenu();
        return { ok: false, error: pickResult.error, previousLevel };
      }

      await sleep(600);
      const after = await this.getThinkingDepth();
      if (!after.ok || after.level !== targetLevel) {
        return { ok: false, error: 'thinking_depth_switch_not_confirmed', previousLevel, requestedLevel: targetLevel, observedLevel: after.level };
      }
      return { ok: true, level: targetLevel, legacyLevel: legacyThinkingLevel(targetLevel), switched: true, previousLevel };
      } catch (error) {
        return { ok: false, error: 'thinking_depth_selection_failed', detail: error.message || String(error) };
      }
    },

    /**
     * 确保当前模型为 Pro，如果不是则自动切换
     *
     * @returns {Promise<{ok: boolean, switched: boolean, previousModel?: string, error?: string}>}
     */
    async ensureModelPro() {
      const isPro = await this.isModelPro();
      if (isPro) {
        console.log('[ops] model is already Pro');
        return { ok: true, switched: false };
      }

      console.log('[ops] model is not Pro, switching...');
      const result = await this.switchToModel('pro');
      if (!result.ok) {
        return { ok: false, switched: false, error: result.error, previousModel: result.previousModel };
      }

      return { ok: true, switched: true, previousModel: result.previousModel };
    },

    /**
     * 填写提示词（快速填充，非逐字输入）
     * @param {string} text
     */
    async fillPrompt(text) {
      return op.fill(SELECTORS.promptInput, text);
    },

    /**
     * 获取输入区 action 按钮的详细状态
     *
     * 状态模型（基于 DOM class 判断）：
     *
     * ┌──────────────────────────────────────────────────────────────────┐
     * │  input-buttons-wrapper-bottom（父容器）                          │
     * │  ┌─────────────────────┐  ┌────────────────────────────────┐   │
     * │  │ mic-button-container│  │ send-button-container          │   │
     * │  │  class 带 hidden    │  │  class 带 visible / 无         │   │
     * │  │  → 输入框有文字     │  │  ┌──────────────────────────┐  │   │
     * │  │  class 无 hidden    │  │  │ button.send-button       │  │   │
     * │  │  → 输入框为空(待命) │  │  │  class 尾 submit → 可发送│  │   │
     * │  └─────────────────────┘  │  │  class 尾 stop   → 加载中│  │   │
     * │                           │  └──────────────────────────┘  │   │
     * │                           └────────────────────────────────┘   │
     * └──────────────────────────────────────────────────────────────────┘
     *
     * 返回值：
     *   - status: 'mic'     — 麦克风态（输入框为空，Gemini 待命）
     *   - status: 'submit'  — 发送态（输入框有文字，可点击发送）
     *   - status: 'stop'    — 加载态（Gemini 正在回答，按钮变为停止）
     *   - status: 'unknown' — 无法识别
     *
     * @returns {Promise<{status: 'mic'|'submit'|'stop'|'unknown', micHidden: boolean, sendVisible: boolean, btnClass: string, error?: string}>}
     */
    async getStatus() {
      return op.query((selectors) => {
        const { micContainer: micSels, sendBtnContainer: sendSels, sendBtn: btnSels } = selectors;

        // ── 查找麦克风容器 ──
        let micEl = null;
        for (const sel of micSels) {
          try { micEl = document.querySelector(sel); } catch { /* skip */ }
          if (micEl) break;
        }

        // ── 查找发送按钮容器 ──
        let sendContainerEl = null;
        for (const sel of sendSels) {
          try { sendContainerEl = document.querySelector(sel); } catch { /* skip */ }
          if (sendContainerEl) break;
        }

        // ── 查找发送按钮本身 ──
        let btnEl = null;
        for (const sel of btnSels) {
          try { btnEl = document.querySelector(sel); } catch { /* skip */ }
          if (btnEl) break;
        }

        // 都找不到则 unknown
        if (!micEl && !sendContainerEl) {
          return { status: 'unknown', micHidden: false, sendVisible: false, btnClass: '', error: 'containers_not_found' };
        }

        const micClass = micEl ? micEl.className : '';
        const sendClass = sendContainerEl ? sendContainerEl.className : '';
        // 新 UI 的 submit/stop 状态在外层 gem-icon-button 上，旧 UI 在 button 自身
        // 同时收集两层的 class，统一判断
        let btnClass = btnEl ? btnEl.className : '';
        if (btnEl) {
          const wrapper = btnEl.closest('gem-icon-button');
          if (wrapper) btnClass += ' ' + wrapper.className;
        }

        const micHidden = /\bhidden\b/.test(micClass);
        const sendVisible = /\bvisible\b/.test(sendClass);

        // ── 判断状态 ──
        // 1. 发送容器可见 → 看按钮 class 是 submit 还是 stop
        if (sendVisible) {
          if (/\bstop\b/.test(btnClass)) {
            return { status: 'stop', micHidden, sendVisible, btnClass };
          }
          if (/\bsubmit\b/.test(btnClass)) {
            return { status: 'submit', micHidden, sendVisible, btnClass };
          }
          // 发送容器可见但按钮 class 无法识别，降级为 submit
          return { status: 'submit', micHidden, sendVisible, btnClass };
        }

        // 2. 麦克风未隐藏 → 待命态（输入框为空）
        if (!micHidden) {
          return { status: 'mic', micHidden, sendVisible, btnClass };
        }

        // 3. 麦克风隐藏但发送容器不可见 → 可能的中间状态，用按钮 class 兜底
        if (/\bstop\b/.test(btnClass)) {
          return { status: 'stop', micHidden, sendVisible, btnClass };
        }

        return { status: 'unknown', micHidden, sendVisible, btnClass, error: 'ambiguous_state' };
      }, { micContainer: SELECTORS.micContainer, sendBtnContainer: SELECTORS.sendBtnContainer, sendBtn: SELECTORS.sendBtn });
    },

    /**
     * 判断 Gemini 当前的回答状态
     *
     * 基于 actionBtn 状态推导：
     *   - 'idle'       — 待命（麦克风态 或 发送态，Gemini 没在回答）
     *   - 'answering'  — 回答中（按钮为 stop 态，Gemini 正在生成）
     *
     * @returns {Promise<{answering: boolean, status: 'idle'|'answering', detail: object}>}
     */
    async getAnswerState() {
      const detail = await this.getStatus();
      const answering = detail.status === 'stop';
      return {
        answering,
        status: answering ? 'answering' : 'idle',
        detail,
      };
    },

    /**
     * 单次轮询状态（保活式，不阻塞）
     */
    async pollStatus() {
      const status = await this.getStatus();
      const pageVisible = await op.query(() => !document.hidden);
      return { ...status, pageVisible, ts: Date.now() };
    },

    /**
     * 检查生成的图片是否加载完成
     *
     * 通过检测页面中 div.loader.animate 元素判断：
     *   存在 → 图片还在加载中
     *   不存在 → 加载完毕
     *
     * @returns {Promise<{loaded: boolean}>}
     */
    async checkImageLoaded() {
      return isImageLoaded(op);
    },

    /**
     * Capture the current model-response turns and their image descendants.
     * Only `div.response-content` nodes are treated as model replies; user
     * prompts, composer attachments, and reference images are not baselined as
     * assistant output.
     */
    async getResponseSnapshot() {
      return op.query(() => {
        const responseSelector = 'div.response-content';
        const responses = [...document.querySelectorAll(responseSelector)];
        const loadedImages = [...document.querySelectorAll('img.image.loaded')];

        const stableAttributes = (el) => {
          if (!el?.attributes) return '';
          const attrs = [...el.attributes]
            .filter(attr => attr.name === 'id'
              || attr.name === 'data-test-id'
              || attr.name === 'data-message-id'
              || attr.name === 'data-turn-id'
              || attr.name === 'data-conversation-id'
              || attr.name === 'data-thread-id'
              || attr.name === 'data-session-id'
              || attr.name === 'data-id'
              || attr.name === 'aria-label')
            .map(attr => `${attr.name}=${attr.value}`)
            .sort();
          return attrs.join(',');
        };

        const responseRoot = (el) => {
          let root = el;
          let parent = el.parentElement;
          for (let depth = 0; parent && parent !== document.body && depth < 3; depth++) {
            if (parent.querySelectorAll(responseSelector).length > 1) break;
            root = parent;
            const semantic = `${parent.getAttribute?.('data-test-id') || ''} ${parent.id || ''} ${typeof parent.className === 'string' ? parent.className : ''}`;
            if (/response|turn|message|model/i.test(semantic)) break;
            parent = parent.parentElement;
          }
          return root;
        };

        const imageInfo = (img) => {
          const src = img.currentSrc || img.src || '';
          return {
            src,
            alt: img.alt || '',
            width: img.naturalWidth || 0,
            height: img.naturalHeight || 0,
            loaded: !!img.complete && (img.naturalWidth || 0) > 0,
            index: loadedImages.indexOf(img) >= 0 ? loadedImages.indexOf(img) : null,
            isNew: !img.classList?.contains('animate'),
          };
        };

        const turns = responses.map((el, index) => {
          const root = responseRoot(el);
          const identityParts = [];
          let node = el;
          for (let depth = 0; node && node !== document.body && depth < 7; depth++, node = node.parentElement) {
            const attrs = stableAttributes(node);
            if (attrs) identityParts.push(`${node.tagName.toLowerCase()}[${attrs}]`);
          }
          const identity = `${identityParts.join('/') || 'response'}#${index}`;
          const images = [...root.querySelectorAll('img')].map(imageInfo);
          const loader = !!root.querySelector('div.loader.animate');
          return {
            index,
            identity,
            text: (el.innerText || '').trim(),
            images,
            loader,
          };
        });

        const chatRoot = document.querySelector('[data-conversation-id]')
          || document.querySelector('[data-thread-id]')
          || document.querySelector('[data-test-id*="conversation"]')
          || document.querySelector('[data-test-id="chat-history"]')
          || document.querySelector('main')
          || document.body;
        const chatIdentity = stableAttributes(chatRoot) || chatRoot?.tagName?.toLowerCase() || 'document';
        const pageKey = `${location.href}|${chatIdentity}`;
        const userNodes = [
          ...document.querySelectorAll('user-query'),
          ...document.querySelectorAll('[data-test-id="user-query"]'),
          ...document.querySelectorAll('[data-test-id*="user-query"]'),
        ];
        const userTurnTexts = [...new Set(userNodes)]
          .map(node => (node.innerText || node.textContent || '').trim())
          .filter(Boolean);
        return {
          ok: true,
          pageKey,
          pathname: location.pathname,
          userTurnTexts,
          responses: turns,
          imageSources: [...new Set(turns.flatMap(turn => turn.images.map(img => img.src)).filter(Boolean))],
          total: turns.length,
        };
      });
    },

    /** Return image state scoped to a single response, not the page tail. */
    async getResponseImages({ index, identity, pageKey } = {}) {
      return op.query((targetIndex, expectedIdentity, expectedPageKey) => {
        const responseSelector = 'div.response-content';
        const responses = [...document.querySelectorAll(responseSelector)];
        const stableAttributes = (node) => {
          if (!node?.attributes) return '';
          return [...node.attributes]
            .filter(attr => attr.name === 'id'
              || attr.name === 'data-test-id'
              || attr.name === 'data-message-id'
              || attr.name === 'data-turn-id'
              || attr.name === 'data-conversation-id'
              || attr.name === 'data-thread-id'
              || attr.name === 'data-session-id'
              || attr.name === 'data-id'
              || attr.name === 'aria-label')
            .map(attr => `${attr.name}=${attr.value}`)
            .sort()
            .join(',');
        };
        const chatRoot = document.querySelector('[data-conversation-id]')
          || document.querySelector('[data-thread-id]')
          || document.querySelector('[data-test-id*="conversation"]')
          || document.querySelector('[data-test-id="chat-history"]')
          || document.querySelector('main')
          || document.body;
        const chatIdentity = stableAttributes(chatRoot) || chatRoot?.tagName?.toLowerCase() || 'document';
        const currentPageKey = `${location.href}|${chatIdentity}`;
        if (expectedPageKey && currentPageKey !== expectedPageKey) return { ok: false, error: 'page_changed' };
        if (targetIndex == null || targetIndex < 0 || targetIndex >= responses.length) {
          return { ok: false, error: 'page_changed' };
        }

        const el = responses[targetIndex];
        const parts = [];
        let node = el;
        for (let depth = 0; node && node !== document.body && depth < 7; depth++, node = node.parentElement) {
          const attrs = stableAttributes(node);
          if (attrs) parts.push(`${node.tagName.toLowerCase()}[${attrs}]`);
        }
        const currentIdentity = `${parts.join('/') || 'response'}#${targetIndex}`;
        if (expectedIdentity && currentIdentity !== expectedIdentity) return { ok: false, error: 'page_changed' };

        let root = el;
        let parent = el.parentElement;
        for (let depth = 0; parent && parent !== document.body && depth < 3; depth++) {
          if (parent.querySelectorAll(responseSelector).length > 1) break;
          root = parent;
          const semantic = `${parent.getAttribute?.('data-test-id') || ''} ${parent.id || ''} ${typeof parent.className === 'string' ? parent.className : ''}`;
          if (/response|turn|message|model/i.test(semantic)) break;
          parent = parent.parentElement;
        }

        const loadedImages = [...document.querySelectorAll('img.image.loaded')];
        const images = [...root.querySelectorAll('img')].map(img => {
          const src = img.currentSrc || img.src || '';
          const globalIndex = loadedImages.indexOf(img);
          return {
            src,
            alt: img.alt || '',
            width: img.naturalWidth || 0,
            height: img.naturalHeight || 0,
            loaded: !!img.complete && (img.naturalWidth || 0) > 0,
            index: globalIndex >= 0 ? globalIndex : null,
          };
        });
        return {
          ok: true,
          pageKey: currentPageKey,
          identity: currentIdentity,
          images,
          loader: !!root.querySelector('div.loader.animate'),
        };
      }, index, identity, pageKey);
    },

    /**
     * 获取当前会话中所有 Gemini 的文字回复
     *
     * 选择器：div.response-content
     * 直接使用 innerText 提取渲染后的文本，浏览器排版引擎会自动处理换行和格式
     *
     * @returns {Promise<{ok: boolean, responses: Array<{index: number, text: string}>, total: number, error?: string}>}
     */
    async getAllTextResponses() {
      return op.query(() => {
        const divs = [...document.querySelectorAll('div.response-content')];
        if (!divs.length) {
          return { ok: false, responses: [], total: 0, error: 'no_responses' };
        }

        const responses = divs.map((div, i) => ({
          index: i,
          text: (div.innerText || '').trim(),
        }));

        return { ok: true, responses, total: responses.length };
      });
    },

    /**
     * 获取最新一条 Gemini 文字回复
     *
     * 取最后一个 div.response-content，使用 innerText 提取渲染后的文本
     *
     * @returns {Promise<{ok: boolean, text?: string, index?: number, error?: string}>}
     */
    async getLatestTextResponse() {
      return op.query(() => {
        const divs = [...document.querySelectorAll('div.response-content')];
        if (!divs.length) {
          return { ok: false, error: 'no_responses' };
        }

        const last = divs[divs.length - 1];
        return { ok: true, text: (last.innerText || '').trim(), index: divs.length - 1 };
      });
    },

    /**
     * 获取本次会话中所有已加载的图片
     *
     * 选择器逻辑：
     *   - img.image.loaded — 历史已加载图片（不带 animate）
     *   - img.image.animate.loaded — 最新生成的图片（带入场动画）
     *   两者都匹配 img.image.loaded，所以用它拿全部。
     *
     * @returns {Promise<{ok: boolean, images: Array<{src: string, alt: string, width: number, height: number, isNew: boolean, index: number}>, total: number, newCount: number, error?: string}>}
     */
    async getAllImages() {
      return op.query(() => {
        const imgs = [...document.querySelectorAll('img.image.loaded')];
        if (!imgs.length) {
          return { ok: false, images: [], total: 0, newCount: 0, error: 'no_loaded_images' };
        }

        const images = imgs.map((img, i) => ({
          src: img.src || '',
          alt: img.alt || '',
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          isNew: img.classList.contains('animate'),
          index: i,
        }));

        const newCount = images.filter(i => i.isNew).length;
        return { ok: true, images, total: images.length, newCount };
      });
    },

    /**
     * 获取最新生成的图片信息
     *
     * 优先查找带 animate class 的图片（刚生成的），
     * 如果没有则回退到最后一张已加载图片。
     *
     * @returns {Promise<{ok: boolean, src?: string, alt?: string, width?: number, height?: number, isNew?: boolean, hasDownloadBtn?: boolean, error?: string}>}
     */
    async getLatestImage() {
      return op.query(() => {
        // 优先：最新生成的图片（带 animate）
        const newImgs = [...document.querySelectorAll('img.image.animate.loaded')];
        // 回退：所有已加载图片
        const allImgs = [...document.querySelectorAll('img.image.loaded')];

        if (!allImgs.length) {
          return { ok: false, error: 'no_loaded_images' };
        }

        // 取最新生成的最后一张，没有则取全部的最后一张
        const img = newImgs.length > 0
          ? newImgs[newImgs.length - 1]
          : allImgs[allImgs.length - 1];
        const isNew = newImgs.length > 0 && newImgs[newImgs.length - 1] === img;

        // 查找下载按钮
        let container = img;
        while (container && container !== document.body) {
          if (container.classList?.contains('image-container')) break;
          container = container.parentElement;
        }
        const dlBtn = container
          ? (container.querySelector('mat-icon[fonticon="download"]')
            || container.querySelector('mat-icon[data-mat-icon-name="download"]'))
          : null;

        return {
          ok: true,
          src: img.src || '',
          alt: img.alt || '',
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          isNew,
          hasDownloadBtn: !!dlBtn,
        };
      });
    },

    /**
    * 提取指定图片的 Base64 数据
    *
    * 策略（根据 URL 类型自动选择）：
    *   A. blob: URL →
    *      A1. Canvas drawImage（最可靠：只要 img 还在 DOM 上就能画，不受 blob revoke 影响）
    *      A2. 页面内 fetch + FileReader（Canvas 被 taint 时兜底）
    *   B. 非 blob URL → CDP loadNetworkResource（通过 CDP 协议绕过 CORS）
    *
    * @param {string} url - 目标图片的 src URL
    * @returns {Promise<{ok: boolean, dataUrl?: string, method?: 'canvas'|'fetch'|'cdp', error?: string}>}
     */
   async extractImageBase64(url) {
     if (!url) {
       console.warn('[extractImageBase64] ❌ 未提供 url 参数');
       return { ok: false, error: 'missing_url' };
     }
     console.log(`[extractImageBase64] 🔍 开始提取, url=${url.slice(0, 120)}...`);

     const isBlob = url.startsWith('blob:');

     // ── 策略 A: blob: URL → Canvas 绘制优先，fetch 兜底 ──
     // blob: URL 是页面自己创建的，img 已渲染在 DOM 上，Canvas drawImage 不会被 taint。
     // 如果 blob 已被 revoke，fetch 会失败，但 Canvas 只要 img 还在 DOM 上就能画。
     if (isBlob) {
       // ── A1: Canvas 提取（最可靠：只要图片还显示在页面上就能提取） ──
       console.log('[extractImageBase64] 🎨 检测到 blob: URL，尝试 Canvas 提取...');
       const canvasResult = await op.query((targetUrl) => {
         const imgs = [...document.querySelectorAll('img.image.loaded')];
         const img = imgs.find(i => i.src === targetUrl);
         if (!img) {
           // 如果精确匹配失败，回退到最后一张
           const fallback = imgs[imgs.length - 1];
           if (!fallback) return { ok: false, error: 'no_loaded_images', searched: 0 };
           // 用最后一张图片
           const w = fallback.naturalWidth || fallback.width;
           const h = fallback.naturalHeight || fallback.height;
           try {
             const canvas = document.createElement('canvas');
             canvas.width = w;
             canvas.height = h;
             canvas.getContext('2d').drawImage(fallback, 0, 0);
             const dataUrl = canvas.toDataURL('image/png');
             return { ok: true, dataUrl, width: w, height: h, method: 'canvas', note: 'fallback_to_last' };
           } catch (e) {
             return { ok: false, error: 'canvas_tainted', detail: e.message || String(e), width: w, height: h };
           }
         }
         const w = img.naturalWidth || img.width;
         const h = img.naturalHeight || img.height;
         try {
           const canvas = document.createElement('canvas');
           canvas.width = w;
           canvas.height = h;
           canvas.getContext('2d').drawImage(img, 0, 0);
           const dataUrl = canvas.toDataURL('image/png');
           return { ok: true, dataUrl, width: w, height: h, method: 'canvas' };
         } catch (e) {
           return { ok: false, error: 'canvas_tainted', detail: e.message || String(e), width: w, height: h, needFetch: true };
         }
       }, url);

       if (canvasResult.ok) {
         console.log(`[extractImageBase64] ✅ Canvas 提取成功 (${canvasResult.width}x${canvasResult.height}${canvasResult.note ? ', ' + canvasResult.note : ''})`);

         // 去水印处理
         const wmResult = await removeWatermarkFromDataUrl(canvasResult.dataUrl);
         if (wmResult.ok && !wmResult.skipped) {
           console.log(`[extractImageBase64] 🍌 水印已移除 (${wmResult.width}×${wmResult.height}, logo=${wmResult.logoSize}px)`);
           return { ok: true, dataUrl: wmResult.dataUrl, method: 'canvas' };
         } else if (wmResult.skipped) {
           console.log(`[extractImageBase64] 跳过去水印: ${wmResult.reason}`);
         } else {
           console.warn(`[extractImageBase64] 去水印失败（不影响提取结果）: ${wmResult.error}`);
         }

         return { ok: true, dataUrl: canvasResult.dataUrl, method: 'canvas' };
       }

       console.warn(`[extractImageBase64] ⚠ Canvas 提取失败: ${canvasResult.error}${canvasResult.detail ? ' — ' + canvasResult.detail : ''}`);

       // ── A2: 页面 fetch 兜底（blob 未被 revoke 时有效） ──
       if (canvasResult.needFetch || canvasResult.error === 'canvas_tainted') {
         console.log('[extractImageBase64] 📦 Canvas 被污染，尝试页面内 fetch 兜底...');
         try {
           const fetchResult = await op.query(async (src) => {
             try {
               const r = await fetch(src);
               if (!r.ok) return { ok: false, error: `fetch_status_${r.status}` };
               const blob = await r.blob();
               const mime = blob.type || 'image/png';
               return await new Promise((resolve) => {
                 const reader = new FileReader();
                 reader.onloadend = () => resolve({ ok: true, dataUrl: reader.result, mime, method: 'fetch' });
                 reader.onerror = () => resolve({ ok: false, error: 'filereader_error' });
                 reader.readAsDataURL(blob);
               });
             } catch (err) {
               return { ok: false, error: 'fetch_failed', detail: err.message || String(err) };
             }
           }, url);

           if (fetchResult.ok) {
             console.log(`[extractImageBase64] ✅ 页面 fetch 提取成功 (mime=${fetchResult.mime})`);

             // 去水印处理
             const wmResult = await removeWatermarkFromDataUrl(fetchResult.dataUrl);
             if (wmResult.ok && !wmResult.skipped) {
               console.log(`[extractImageBase64] 🍌 水印已移除 (${wmResult.width}×${wmResult.height}, logo=${wmResult.logoSize}px)`);
               return { ok: true, dataUrl: wmResult.dataUrl, method: 'fetch' };
             } else if (wmResult.skipped) {
               console.log(`[extractImageBase64] 跳过去水印: ${wmResult.reason}`);
             } else {
               console.warn(`[extractImageBase64] 去水印失败（不影响提取结果）: ${wmResult.error}`);
             }

             return { ok: true, dataUrl: fetchResult.dataUrl, method: 'fetch' };
           }
           console.warn(`[extractImageBase64] ⚠ 页面 fetch 也失败: ${fetchResult.error}`);
         } catch (err) {
           console.warn(`[extractImageBase64] ❌ 页面 fetch 异常: ${err.message || String(err)}`);
         }
       }

       return { ok: false, error: canvasResult.error || 'blob_extract_failed', detail: canvasResult.detail };
     }

     // ── 策略 B: 非 blob URL → CDP Network.loadNetworkResource（绕过 CORS） ──
     try {
        const client = page._client();
        const frameId = page.mainFrame()._id;

        console.log(`[extractImageBase64] 📡 CDP 请求中... frameId=${frameId}`);
        const { resource } = await client.send('Network.loadNetworkResource', {
          frameId,
          url,
          options: { disableCache: false, includeCredentials: true },
        });

        if (!resource.success) {
          const errMsg = `CDP 请求失败: httpStatusCode=${resource.httpStatusCode || 'N/A'}`;
          console.warn(`[extractImageBase64] ❌ ${errMsg}`);
          return { ok: false, error: 'cdp_request_failed', detail: errMsg };
        }

        // 通过 IO.read 读取 stream 数据
        const streamHandle = resource.stream;
        if (!streamHandle) {
          console.warn('[extractImageBase64] ❌ CDP 返回无 stream handle');
          return { ok: false, error: 'cdp_no_stream' };
        }

        // 【关键修复】：CDP IO.read 分块返回的 base64 不能直接拼接字符串！
        // 每个 chunk 是独立编码的 base64，末尾可能有 '=' 填充符，
        // 直接 join 会导致中间插入非法字符 → 解码后数据损坏。
        // 正确做法：先把每个 chunk 解码为 Buffer，拼接 Buffer，最后统一编码。
        const bufferChunks = [];
        let eof = false;
        while (!eof) {
          const { data, base64Encoded, eof: done } = await client.send('IO.read', {
            handle: streamHandle,
            size: 1024 * 1024, // 每次读 1MB
          });
          if (data) {
            bufferChunks.push(base64Encoded ? Buffer.from(data, 'base64') : Buffer.from(data));
          }
          eof = done;
        }
        await client.send('IO.close', { handle: streamHandle });

        const fullBuffer = Buffer.concat(bufferChunks);
        const base64Full = fullBuffer.toString('base64');
        // 从 response headers 推断 MIME；CDP 有时不提供，默认用 image/png
        const mime = (resource.headers?.['content-type'] || resource.headers?.['Content-Type'] || 'image/png').split(';')[0].trim();
        const dataUrl = `data:${mime};base64,${base64Full}`;

        console.log(`[extractImageBase64] ✅ CDP 提取成功 (mime=${mime}, size=${(base64Full.length * 0.75 / 1024).toFixed(1)}KB)`);

        // 去水印处理
        const wmResult = await removeWatermarkFromDataUrl(dataUrl);
        if (wmResult.ok && !wmResult.skipped) {
          console.log(`[extractImageBase64] 🍌 水印已移除 (${wmResult.width}×${wmResult.height}, logo=${wmResult.logoSize}px)`);
          return { ok: true, dataUrl: wmResult.dataUrl, method: 'cdp' };
        } else if (wmResult.skipped) {
          console.log(`[extractImageBase64] 跳过去水印: ${wmResult.reason}`);
        } else {
          console.warn(`[extractImageBase64] 去水印失败（不影响提取结果）: ${wmResult.error}`);
        }

        return { ok: true, dataUrl, method: 'cdp' };
      } catch (err) {
        const errMsg = err.message || String(err);
        console.warn(`[extractImageBase64] ❌ CDP 提取异常: ${errMsg}`);
        return { ok: false, error: 'cdp_error', detail: errMsg };
      }
    },

    /**
     * 点击最新图片的下载按钮
     */
    async downloadLatestImage() {
      return op.query(() => {
        const imgs = [...document.querySelectorAll('img.image.loaded')];
        if (!imgs.length) return { ok: false, error: 'no_loaded_images' };

        const img = imgs[imgs.length - 1];
        let container = img;
        while (container && container !== document.body) {
          if (container.classList?.contains('image-container')) break;
          container = container.parentElement;
        }
        const dlBtn = container
          ? (container.querySelector('mat-icon[fonticon="download"]')
            || container.querySelector('mat-icon[data-mat-icon-name="download"]'))
          : null;

        if (!dlBtn) return { ok: false, error: 'download_btn_not_found' };

        const clickable = dlBtn.closest('button,[role="button"],.button-icon-wrapper') || dlBtn;
        clickable.click();
        return { ok: true, src: img.src || '' };
      });
    },

    /**
     * 下载完整尺寸的图片
     *
     * 流程：
     *   1. 定位目标图片，获取坐标用于 hover
     *   2. 为本次下载创建隔离目录，并通过公开 Browser CDP session 设置下载目录
     *   3. hover 触发工具栏 → 点击"下载完整尺寸"按钮
     *   4. 监听 CDP Browser.downloadWillBegin / Browser.downloadProgress 等待下载完成
     *   5. 返回实际保存的文件路径
     *
     * 按钮选择器：见 SELECTORS.downloadFullSizeBtn（新 UI 用 aria-label="下载完整尺寸的图片"，旧 UI 用 data-test-id="download-generated-image-button"）
     *
     * @param {object} [options]
     * @param {number} [options.index] - 图片索引（从0开始，从旧到新），不传则取最新一张
     * @param {string} [options.imageUrl] - 精确图片 URL；与 index 同传时必须指向同一张图
     * @param {number} [options.timeout=30000] - 下载超时时间（ms）
     * @returns {Promise<{ok: boolean, filePath?: string, suggestedFilename?: string, src?: string, index?: number, total?: number, error?: string}>}
     */
    async downloadFullSizeImage({ index, imageUrl, timeout = 30_000 } = {}) {
      const baseResult = (imgInfo, fields = {}) => ({
        ok: false,
        ...fields,
        ...(imgInfo ? { src: imgInfo.src, index: imgInfo.index, total: imgInfo.total } : {}),
      });
      const urlWasProvided = imageUrl !== undefined && imageUrl !== null;
      if (index !== undefined && index !== null && (!Number.isInteger(index) || index < 0)) {
        return baseResult(null, { error: 'invalid_index' });
      }
      if (urlWasProvided) {
        if (typeof imageUrl !== 'string' || !imageUrl.trim()) return baseResult(null, { error: 'invalid_image_url' });
        try {
          const parsed = new URL(imageUrl);
          if (!['http:', 'https:', 'blob:', 'data:'].includes(parsed.protocol)) {
            return baseResult(null, { error: 'invalid_image_url' });
          }
        } catch {
          return baseResult(null, { error: 'invalid_image_url' });
        }
      }
      const requestedTimeout = Number(timeout);
      if (!Number.isFinite(requestedTimeout) || requestedTimeout < 0) {
        return baseResult(null, { error: 'invalid_timeout' });
      }

      let selected;
      try {
        selected = await op.query((targetIndex, requestedUrl) => {
          const imgs = [...document.querySelectorAll('img.image.loaded')];
          if (!imgs.length) return { ok: false, error: 'no_loaded_images', total: 0 };

          const sourceOf = img => img.currentSrc || img.src || '';
          const normalized = value => {
            try { return new URL(value, location.href).href; } catch { return String(value || ''); }
          };
          let i;
          if (requestedUrl != null) {
            const requested = normalized(requestedUrl);
            const matches = imgs.map((img, position) => normalized(sourceOf(img)) === requested ? position : -1)
              .filter(position => position >= 0);
            if (!matches.length) return { ok: false, error: 'image_not_found', total: imgs.length };
            if (targetIndex != null) {
              if (targetIndex >= imgs.length) {
                return { ok: false, error: 'index_out_of_range', total: imgs.length, requestedIndex: targetIndex };
              }
              if (normalized(sourceOf(imgs[targetIndex])) !== requested) {
                return { ok: false, error: 'image_index_mismatch', total: imgs.length, requestedIndex: targetIndex };
              }
              i = targetIndex;
            } else {
              i = matches[matches.length - 1];
            }
          } else {
            i = targetIndex == null ? imgs.length - 1 : targetIndex;
            if (i < 0 || i >= imgs.length) {
              return { ok: false, error: 'index_out_of_range', total: imgs.length, requestedIndex: i };
            }
          }

          const img = imgs[i];
          img.scrollIntoView({ behavior: 'instant', block: 'center' });
          const rect = img.getBoundingClientRect();
          return {
            ok: true,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            src: sourceOf(img),
            index: i,
            total: imgs.length,
          };
        }, index, urlWasProvided ? imageUrl : null);
      } catch (error) {
        return baseResult(null, { error: error?.message || 'image_selection_failed' });
      }
      if (!selected?.ok) return selected || baseResult(null, { error: 'image_selection_failed' });

      await sleep(500);
      let buttonInfo;
      try {
        await page.mouse.move(selected.x, selected.y);
        await sleep(800);
        buttonInfo = await op.query((targetIndex, expectedSrc, selectors) => {
          const imgs = [...document.querySelectorAll('img.image.loaded')];
          if (targetIndex < 0 || targetIndex >= imgs.length) {
            return { ok: false, error: 'image_changed', total: imgs.length };
          }
          const img = imgs[targetIndex];
          const src = img.currentSrc || img.src || '';
          const normalized = value => {
            try { return new URL(value, location.href).href; } catch { return String(value || ''); }
          };
          if (normalized(src) !== normalized(expectedSrc)) {
            return { ok: false, error: 'image_changed', total: imgs.length };
          }

          const visible = element => {
            const rect = element.getBoundingClientRect();
            if (!(rect.width > 0 && rect.height > 0)) return false;
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
          };
          let scope = img.parentElement;
          for (let depth = 0; scope && scope !== document.body && depth < 14; depth++, scope = scope.parentElement) {
            const scopedImages = [...scope.querySelectorAll('img.image.loaded')];
            if (scopedImages.length !== 1 || scopedImages[0] !== img) continue;
            for (const selector of selectors) {
              let candidates = [];
              try { candidates = [...scope.querySelectorAll(selector)]; } catch { /* unsupported selector */ }
              for (const element of candidates) {
                const button = element.tagName === 'BUTTON'
                  ? element
                  : element.querySelector('button') || element.closest('button') || element;
                if (!visible(button)) continue;
                const rect = button.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                let coordinateHit = null;
                try { coordinateHit = document.elementFromPoint?.(x, y) || null; } catch { /* prefer the deterministic DOM path */ }
                let coordinateCanReachButton = false;
                try {
                  coordinateCanReachButton = !!coordinateHit
                    && (coordinateHit === button || button.contains?.(coordinateHit) === true);
                } catch { /* prefer the deterministic DOM path */ }
                return {
                  ok: true,
                  x,
                  y,
                  selector,
                  clickStrategy: coordinateCanReachButton ? 'coordinate' : 'dom',
                  downloadUrl: button.href || button.getAttribute?.('href') || button.getAttribute?.('data-url') || '',
                };
              }
            }
          }
          return { ok: false, error: 'full_size_download_btn_not_found' };
        }, selected.index, selected.src, SELECTORS.downloadFullSizeBtn);
      } catch (error) {
        return baseResult(selected, { error: error?.message || 'download_button_lookup_failed' });
      }
      if (!buttonInfo?.ok) return baseResult(selected, { error: buttonInfo?.error || 'full_size_download_btn_not_found' });

      let workspace;
      let browserSession;
      let pageSession;
      let lifecycle;
      let pageFrameListeners = [];
      let pendingPageFrames = [];
      let eventPromiseConsumed = false;
      let downloadBehaviorChanged = false;
      let restoreError = null;
      let outcome;
      try {
        const browser = page.browser?.();
        const browserTarget = browser?.target?.();
        if (!browserTarget || typeof browserTarget.createCDPSession !== 'function'
          || typeof page.createCDPSession !== 'function') {
          return baseResult(selected, { error: 'public_cdp_session_unavailable' });
        }

        browserSession = await browserTarget.createCDPSession();
        pageSession = await page.createCDPSession();
        const queuePageFrame = (childFrameId, parentFrameId) => {
          if (lifecycle) lifecycle.addFrame(childFrameId, parentFrameId);
          else pendingPageFrames.push([childFrameId, parentFrameId]);
        };
        if (typeof pageSession.on === 'function') {
          const onFrameAttached = event => queuePageFrame(event?.frameId, event?.parentFrameId);
          const onFrameNavigated = event => queuePageFrame(event?.frame?.id, event?.frame?.parentId);
          pageSession.on('Page.frameAttached', onFrameAttached);
          pageSession.on('Page.frameNavigated', onFrameNavigated);
          pageFrameListeners = [
            ['Page.frameAttached', onFrameAttached],
            ['Page.frameNavigated', onFrameNavigated],
          ];
        }
        await pageSession.send('Page.enable');
        const frameResult = await pageSession.send('Page.getFrameTree');
        const frame = frameResult?.frameTree?.frame;
        if (!frame?.id) return baseResult(selected, { error: 'main_frame_unavailable' });
        const frameIds = [];
        const collectFrameIds = treeNode => {
          if (!treeNode) return;
          if (treeNode.frame?.id) frameIds.push(treeNode.frame.id);
          for (const child of treeNode.childFrames || []) collectFrameIds(child);
        };
        collectFrameIds(frameResult.frameTree);

        workspace = createDownloadWorkspace(config.outputDir);
        downloadBehaviorChanged = true;
        await browserSession.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: workspace.directory,
          eventsEnabled: true,
        });
        lifecycle = createDownloadLifecycle(browserSession, {
          frameId: frame.id,
          frameIds,
          imageUrl: selected.src,
          resourceUrls: [buttonInfo.downloadUrl],
          timeout: Math.max(1, requestedTimeout),
        });
        for (const [childFrameId, parentFrameId] of pendingPageFrames) {
          lifecycle.addFrame(childFrameId, parentFrameId);
        }
        pendingPageFrames = [];

        lifecycle.arm();
        if (buttonInfo.clickStrategy === 'coordinate') {
          // The event may be delayed; never retry a dispatched input action.
          lifecycle.setClickStatus('coordinate', 'attempting');
          try {
            await page.mouse.click(buttonInfo.x, buttonInfo.y);
            lifecycle.setClickStatus('coordinate', 'dispatched');
          } catch (error) {
            lifecycle.setClickStatus('coordinate', 'dispatch_error');
            throw error;
          }
        } else {
          // Decide DOM-vs-coordinate before dispatch. Once this single action is
          // attempted, a missing/late CDP event is a timeout, not a retry signal.
          lifecycle.setClickStatus('dom', 'attempting');
          let fallbackResult;
          try {
            fallbackResult = await op.query((targetIndex, expectedSrc, selectors) => {
            const imgs = [...document.querySelectorAll('img.image.loaded')];
            if (targetIndex < 0 || targetIndex >= imgs.length) return { ok: false, error: 'image_changed' };
            const img = imgs[targetIndex];
            const src = img.currentSrc || img.src || '';
            const normalized = value => {
              try { return new URL(value, location.href).href; } catch { return String(value || ''); }
            };
            if (normalized(src) !== normalized(expectedSrc)) return { ok: false, error: 'image_changed' };
            const visible = element => {
              const rect = element.getBoundingClientRect();
              if (!(rect.width > 0 && rect.height > 0)) return false;
              const style = getComputedStyle(element);
              return style.display !== 'none' && style.visibility !== 'hidden';
            };
            let scope = img.parentElement;
            for (let depth = 0; scope && scope !== document.body && depth < 14; depth++, scope = scope.parentElement) {
              const scopedImages = [...scope.querySelectorAll('img.image.loaded')];
              if (scopedImages.length !== 1 || scopedImages[0] !== img) continue;
              for (const selector of selectors) {
                let candidates = [];
                try { candidates = [...scope.querySelectorAll(selector)]; } catch { /* unsupported selector */ }
                for (const element of candidates) {
                  const button = element.tagName === 'BUTTON'
                    ? element
                    : element.querySelector('button') || element.closest('button') || element;
                  if (!visible(button)) continue;
                  button.click();
                  return { ok: true, selector, dispatched: true };
                }
              }
            }
            return { ok: false, error: 'full_size_download_btn_not_found' };
            }, selected.index, selected.src, SELECTORS.downloadFullSizeBtn);
          } catch (error) {
            lifecycle.setClickStatus('dom', 'dispatch_error');
            throw error;
          }
          lifecycle.setClickStatus('dom', fallbackResult?.dispatched ? 'dispatched' : 'not_dispatched');
          if (!fallbackResult?.ok) lifecycle.cancel(fallbackResult?.error || 'full_size_download_btn_not_found');
        }

        eventPromiseConsumed = true;
        const download = await lifecycle.promise;
        if (!download.ok) {
          outcome = baseResult(selected, { error: download.error });
        } else {
          const file = workspace.finalize(download);
          if (!file.ok) {
            outcome = baseResult(selected, { error: file.error, filePath: file.filePath });
          } else {
            // Preserve the current fullSize contract; optional/conditional
            // watermark behavior is intentionally left for the second pass.
            const wmResult = await removeWatermarkFromFile(file.filePath);
            if (wmResult.ok && !wmResult.skipped) {
              console.log(`[ops] 水印已移除 (${wmResult.width}×${wmResult.height}, logo=${wmResult.logoSize}px)`);
            } else if (wmResult.skipped) {
              console.log(`[ops] 跳过去水印: ${wmResult.reason}`);
            } else {
              console.warn(`[ops] 去水印失败（不影响下载结果）: ${wmResult.error}`);
            }
            outcome = {
              ok: true,
              filePath: file.filePath,
              suggestedFilename: file.suggestedFilename,
              src: selected.src,
              index: selected.index,
              total: selected.total,
            };
          }
        }
      } catch (error) {
        outcome = baseResult(selected, { error: error?.message || 'download_failed' });
      } finally {
        if (lifecycle) {
          if (!eventPromiseConsumed) {
            lifecycle.cancel('download_aborted');
            await lifecycle.promise;
          }
          lifecycle.cleanup();
        }
        for (const [eventName, handler] of pageFrameListeners) {
          try {
            if (typeof pageSession?.off === 'function') pageSession.off(eventName, handler);
            else pageSession?.removeListener?.(eventName, handler);
          } catch { /* page target may already be detached */ }
        }
        pageFrameListeners = [];
        if (downloadBehaviorChanged && browserSession) {
          try {
            await browserSession.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: false });
          } catch (error) {
            restoreError = error?.message || 'download_behavior_restore_failed';
          }
        }
        for (const session of [pageSession, browserSession]) {
          try { await session?.detach?.(); } catch { /* detached or target closed */ }
        }
      }
      if (restoreError) {
        if (outcome?.ok) {
          outcome = { ...outcome, ok: false, error: 'download_behavior_restore_failed', detail: restoreError };
        } else if (outcome) {
          outcome.restoreError = restoreError;
        }
      }
      if (outcome && workspace && existsSync(workspace.directory)) {
        outcome.downloadDir = workspace.directory;
      }
      if (outcome && lifecycle) {
        const diagnostics = lifecycle.getDiagnostics();
        if (outcome.error && workspace) {
          diagnostics.downloadDirectory = workspace.directory;
          diagnostics.downloadDirectoryEntries = workspace.inspect();
        }
        outcome.diagnostics = diagnostics;
        const line = `[ops] full-size download diagnostics: ${JSON.stringify(diagnostics)}`;
        if (outcome.error) console.warn(line);
        else console.info(line);
      }
      return outcome || baseResult(selected, { error: 'download_failed' });
    },

    /**
     * 为当前会话中的图片创建 Gemini 公开分享链接
     *
     * 流程：
     *   1. 关闭可能残留的旧分享弹窗
     *   2. 将目标图片滚动到视口中央并 hover，触发图片工具栏
     *   3. 点击 Share image
     *   4. 等待 Gemini 生成 share 链接
     *   5. 读取链接；若复制按钮可用则顺手点击复制
     *   6. 按需关闭弹窗
     *
     * @param {object} [options]
     * @param {number} [options.index] - 图片索引（从0开始，从旧到新），不传则分享最新一张
     * @param {number} [options.timeout=30000] - 等待 share 链接生成的超时时间（ms）
     * @param {boolean} [options.copyToClipboard=true] - 是否点击“Copy link”
     * @param {boolean} [options.closeDialog=true] - 完成后是否关闭分享弹窗
     * @returns {Promise<{ok: boolean, link?: string, copiedToClipboard?: boolean, dialogClosed?: boolean, index?: number, total?: number, src?: string, error?: string, detail?: string}>}
     */
    async shareLatestImage({ index, timeout = 30_000, copyToClipboard = true, closeDialog = true } = {}) {
      const staleDialog = await this.closeShareDialog({ timeout: 2_000 });
      if (!staleDialog.ok) return staleDialog;

      const imgInfo = await op.query((targetIndex) => {
        const imgs = [...document.querySelectorAll('img.image.loaded')];
        if (!imgs.length) return { ok: false, error: 'no_loaded_images', total: 0 };

        const i = targetIndex == null ? imgs.length - 1 : targetIndex;
        if (i < 0 || i >= imgs.length) {
          return { ok: false, error: 'index_out_of_range', total: imgs.length, requestedIndex: i };
        }

        const img = imgs[i];
        img.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = img.getBoundingClientRect();
        return {
          ok: true,
          index: i,
          total: imgs.length,
          src: img.src || '',
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }, index);

      if (!imgInfo.ok) return imgInfo;

      await sleep(500);

      let shareBtnInfo = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        await page.mouse.move(imgInfo.x, imgInfo.y);
        await sleep(400);

        shareBtnInfo = await op.query((targetIndex, selectors) => {
          const imgs = [...document.querySelectorAll('img.image.loaded')];
          const i = targetIndex == null ? imgs.length - 1 : targetIndex;
          const img = imgs[i];
          if (!img) return { ok: false, error: 'image_not_found' };

          const container = img.closest('.image-container') || img.parentElement?.closest('.image-container');
          if (!container) return { ok: false, error: 'image_container_not_found' };

          let btn = null;
          for (const sel of selectors) {
            try {
              const candidates = [...container.querySelectorAll(sel)];
              btn = candidates.find((el) => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0
                  && style.display !== 'none'
                  && style.visibility !== 'hidden'
                  && style.opacity !== '0';
              }) || null;
            } catch { /* skip bad selector */ }
            if (btn) break;
          }

          if (!btn) return { ok: false, error: 'share_btn_not_found' };

          const rect = btn.getBoundingClientRect();
          return {
            ok: true,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        }, imgInfo.index, SELECTORS.shareImageBtn);

        if (shareBtnInfo.ok) break;
        await sleep(400);
      }

      if (!shareBtnInfo?.ok) {
        return {
          ok: false,
          error: 'share_btn_not_found',
          src: imgInfo.src,
          index: imgInfo.index,
          total: imgInfo.total,
        };
      }

      await page.mouse.move(shareBtnInfo.x, shareBtnInfo.y);
      await sleep(120);
      await page.mouse.down();
      await sleep(80);
      await page.mouse.up();

      const dialogReady = await op.waitFor((selectors) => {
        const dialogs = [];
        const seen = new Set();

        for (const sel of selectors) {
          try {
            for (const el of document.querySelectorAll(sel)) {
              if (seen.has(el)) continue;
              seen.add(el);
              dialogs.push(el);
            }
          } catch { /* skip */ }
        }

        return dialogs.some((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0'
            && (!el.classList.contains('mdc-dialog') || el.classList.contains('mdc-dialog--open'));
        });
      }, { timeout: Math.min(timeout, 10_000), interval: 250, args: [SELECTORS.shareDialog] });

      if (!dialogReady.ok) {
        return {
          ok: false,
          error: 'share_dialog_not_found',
          src: imgInfo.src,
          index: imgInfo.index,
          total: imgInfo.total,
        };
      }

      const deadline = Date.now() + timeout;
      let shareState = null;

      while (Date.now() < deadline) {
        shareState = await op.query((dialogSelectors, linkSelectors, copySelectors, closeSelectors) => {
          const dialogs = [];
          const seen = new Set();

          for (const sel of dialogSelectors) {
            try {
              for (const el of document.querySelectorAll(sel)) {
                if (seen.has(el)) continue;
                seen.add(el);
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                const visible = rect.width > 0
                  && rect.height > 0
                  && style.display !== 'none'
                  && style.visibility !== 'hidden'
                  && style.opacity !== '0'
                  && (!el.classList.contains('mdc-dialog') || el.classList.contains('mdc-dialog--open'));
                if (visible) dialogs.push(el);
              }
            } catch { /* skip */ }
          }

          const dialog = dialogs.at(-1) || null;
          if (!dialog) return { ok: false, error: 'share_dialog_not_found' };

          const findFirst = (selectors) => {
            for (const sel of selectors) {
              try {
                const el = dialog.querySelector(sel);
                if (el) return el;
              } catch { /* skip */ }
            }
            return null;
          };

          const linkEl = findFirst(linkSelectors);
          const copyBtn = findFirst(copySelectors);
          const closeBtn = findFirst(closeSelectors);
          const text = (dialog.innerText || '').trim();

          const copyRect = copyBtn ? copyBtn.getBoundingClientRect() : null;
          const closeRect = closeBtn ? closeBtn.getBoundingClientRect() : null;

          return {
            ok: true,
            href: linkEl?.href || '',
            text,
            copyButton: copyBtn ? {
              disabled: !!copyBtn.disabled || copyBtn.classList.contains('disabled'),
              ariaLabel: copyBtn.getAttribute('aria-label') || '',
              text: (copyBtn.innerText || copyBtn.textContent || '').trim(),
              x: copyRect.left + copyRect.width / 2,
              y: copyRect.top + copyRect.height / 2,
            } : null,
            closeButton: closeBtn ? {
              x: closeRect.left + closeRect.width / 2,
              y: closeRect.top + closeRect.height / 2,
            } : null,
          };
        }, SELECTORS.shareDialog, SELECTORS.shareDialogLink, SELECTORS.shareDialogCopyBtn, SELECTORS.shareDialogCloseBtn);

        if (!shareState.ok) {
          await sleep(300);
          continue;
        }

        const shareLink = normalizeShareLink(shareState.href) || extractShareLinkFromText(shareState.text);
        if (shareLink) {
          let copiedToClipboard = false;

          if (copyToClipboard && shareState.copyButton) {
            const btnState = `${shareState.copyButton.ariaLabel} ${shareState.copyButton.text}`.toLowerCase();
            if (shareState.copyButton.disabled || btnState.includes('link copied') || btnState.includes('已复制链接')) {
              copiedToClipboard = true;
            } else {
              await page.mouse.move(shareState.copyButton.x, shareState.copyButton.y);
              await sleep(100);
              await page.mouse.down();
              await sleep(60);
              await page.mouse.up();
              copiedToClipboard = true;
              await sleep(250);
            }
          }

          let dialogClosed = false;
          if (closeDialog) {
            const closeResult = await this.closeShareDialog({ timeout: 5_000 });
            if (!closeResult.ok) return closeResult;
            dialogClosed = closeResult.closed;
          }

          return {
            ok: true,
            link: shareLink,
            copiedToClipboard,
            dialogClosed,
            src: imgInfo.src,
            index: imgInfo.index,
            total: imgInfo.total,
          };
        }

        await sleep(500);
      }

      return {
        ok: false,
        error: 'share_link_timeout',
        detail: shareState?.text?.slice(0, 200) || '',
        src: imgInfo.src,
        index: imgInfo.index,
        total: imgInfo.total,
      };
    },

    /**
     * 关闭分享弹窗（如果存在）
     *
     * @param {object} [options]
     * @param {number} [options.timeout=5000] - 等待弹窗消失的超时时间（ms）
     * @returns {Promise<{ok: boolean, hadDialog?: boolean, closed?: boolean, error?: string}>}
     */
    async closeShareDialog({ timeout = 5_000 } = {}) {
      let closedAny = false;

      for (let attempt = 1; attempt <= 5; attempt++) {
        const closeInfo = await op.query((dialogSelectors, closeSelectors) => {
          const dialogs = [];
          const seen = new Set();

          for (const sel of dialogSelectors) {
            try {
              for (const el of document.querySelectorAll(sel)) {
                if (seen.has(el)) continue;
                seen.add(el);
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                const visible = rect.width > 0
                  && rect.height > 0
                  && style.display !== 'none'
                  && style.visibility !== 'hidden'
                  && style.opacity !== '0'
                  && (!el.classList.contains('mdc-dialog') || el.classList.contains('mdc-dialog--open'));
                if (visible) dialogs.push(el);
              }
            } catch { /* skip */ }
          }

          const dialog = dialogs.at(-1) || null;
          if (!dialog) {
            return { ok: true, hadDialog: false, closed: false, openCount: 0 };
          }

          let btn = null;
          for (const sel of closeSelectors) {
            try {
              const el = dialog.querySelector(sel);
              if (el) {
                btn = el;
                break;
              }
            } catch { /* skip */ }
          }

          if (!btn) return { ok: false, error: 'share_dialog_close_btn_not_found' };

          const rect = btn.getBoundingClientRect();
          return {
            ok: true,
            hadDialog: true,
            openCount: dialogs.length,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        }, SELECTORS.shareDialog, SELECTORS.shareDialogCloseBtn);

        if (!closeInfo.ok) return closeInfo;
        if (!closeInfo.hadDialog) {
          return { ok: true, hadDialog: closedAny, closed: closedAny };
        }

        await page.mouse.move(closeInfo.x, closeInfo.y);
        await sleep(100);
        await page.mouse.down();
        await sleep(60);
        await page.mouse.up();

        const waitClose = await op.waitFor((selectors, previousCount) => {
          const dialogs = [];
          const seen = new Set();

          for (const sel of selectors) {
            try {
              for (const el of document.querySelectorAll(sel)) {
                if (seen.has(el)) continue;
                seen.add(el);
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                const visible = rect.width > 0
                  && rect.height > 0
                  && style.display !== 'none'
                  && style.visibility !== 'hidden'
                  && style.opacity !== '0'
                  && (!el.classList.contains('mdc-dialog') || el.classList.contains('mdc-dialog--open'));
                if (visible) dialogs.push(el);
              }
            } catch { /* skip */ }
          }

          return dialogs.length < previousCount;
        }, { timeout, interval: 200, args: [SELECTORS.shareDialog, closeInfo.openCount] });

        if (!waitClose.ok) {
          return { ok: false, error: 'share_dialog_close_timeout' };
        }

        closedAny = true;
      }

      return { ok: false, error: 'share_dialog_close_timeout' };
    },

    // ─── 高层组合操作 ───

    /**
     * 刷新当前页面
     *
     * 适用于页面卡住、状态异常等场景。
     * 刷新后会等待页面重新加载完成（waitUntil: networkidle2）。
     *
     * @param {object} [options]
     * @param {number} [options.timeout=30000] - 等待页面加载的超时时间（ms）
     * @returns {Promise<{ok: boolean, elapsed?: number, error?: string, detail?: string}>}
     */
    async reloadPage({ timeout = 30_000 } = {}) {
      try {
        const start = Date.now();
        await page.reload({ waitUntil: 'networkidle2', timeout });
        const elapsed = Date.now() - start;
        console.log(`[ops] 页面刷新完成 (${elapsed}ms)`);
        return { ok: true, elapsed };
      } catch (e) {
        return { ok: false, error: 'reload_failed', detail: e.message };
      }
    },

    /**
     * 导航到指定的 Gemini 页面 URL
     *
     * 仅允许 gemini.google.com 域名下的地址（如指定会话 URL），
     * 其他域名会直接拒绝，防止浏览器被劫持到不安全页面。
     *
     * @param {string} url - 目标 URL，必须是 gemini.google.com 域名
     * @param {object} [options]
     * @param {number} [options.timeout=30000] - 等待页面加载的超时时间（ms）
     * @returns {Promise<{ok: boolean, url?: string, elapsed?: number, error?: string, detail?: string}>}
     */
    async navigateTo(url, { timeout = 30_000 } = {}) {
      try {
        // 域名白名单校验
        const parsed = new URL(url);
        if (parsed.hostname !== 'gemini.google.com') {
          return {
            ok: false,
            error: 'invalid_domain',
            detail: `仅允许 gemini.google.com 域名，收到: ${parsed.hostname}`,
          };
        }

        const start = Date.now();
        await page.goto(url, { waitUntil: 'networkidle2', timeout });
        const elapsed = Date.now() - start;
        const finalUrl = page.url();
        console.log(`[ops] 页面导航完成 → ${finalUrl} (${elapsed}ms)`);
        return { ok: true, url: finalUrl, elapsed };
      } catch (e) {
        return { ok: false, error: 'navigate_failed', detail: e.message };
      }
    },

    /**
     * 上传图片到 Gemini 输入框
     *
     * 流程：
     *   1. 点击加号面板按钮，展开上传菜单
     *   2. 等待 300ms 让菜单动画稳定
     *   3. 拦截文件选择器 + 点击"上传文件"按钮（Promise.all 并发）
     *   4. 向文件选择器塞入指定图片路径
     *   5. 轮询等待图片加载完成（.gem-attachment-content.loading 消失）
     *
     * @param {string} filePath - 本地图片的绝对路径
     * @returns {Promise<{ok: boolean, elapsed?: number, warning?: string, error?: string, detail?: string}>}
     */
    async uploadImage(filePath) {
      try {
        // 路径规范化（兼容 Windows 反斜杠、混合斜杠等）
        filePath = pathResolve(pathNormalize(filePath));

        if (!existsSync(filePath)) {
          return { ok: false, error: 'file_not_found', detail: `文件不存在: ${filePath}` };
        }

        // 1. 点击加号面板按钮，展开上传菜单
        const panelClick = await this.click('uploadPanelBtn');
        if (!panelClick.ok) {
          return { ok: false, error: 'upload_panel_click_failed', detail: panelClick.error };
        }

        // 2. 等待菜单动画稳定
        await sleep(250);

        // 3. Promise.all 是精髓：一边开始监听文件选择器弹窗，一边点击"上传文件"按钮
        const [fileChooser] = await Promise.all([
          page.waitForFileChooser({ timeout: 5_000 }),
          this.click('uploadFileBtn'),
        ]);

        // 4. 弹窗被拦截，塞入文件
        await fileChooser.accept([filePath]);
        console.log(`[ops] 文件已塞入，等待 Gemini 加载图片...`);

        // 5. 等待图片加载完成（.gem-attachment-content.loading 消失）
        const loadTimeout = 15_000;
        const loadInterval = 500;
        const loadStart = Date.now();
        await sleep(500); //  短暂等待 UI 响应
        while (Date.now() - loadStart < loadTimeout) {
          const loading = await op.query(() => {
            // 同时带 gem-attachment-content 和 loading 两个 class，说明还在上传中
            const el = document.querySelector('.gem-attachment-content.loading');
            return !!el;
          });
          if (!loading) {
            console.log(`[ops] 图片上传成功 (${Date.now() - loadStart}ms): ${filePath}`);
            return { ok: true, elapsed: Date.now() - loadStart };
          }
          await sleep(loadInterval);
        }

        // 超时了但文件已经塞进去了，不算完全失败
        console.warn(`[ops] 图片加载超时 (${loadTimeout}ms)，但文件已提交`);
        return { ok: true, warning: 'load_timeout', elapsed: Date.now() - loadStart };
      } catch (e) {
        return { ok: false, error: 'upload_image_failed', detail: e.message };
      }
    },

    /**
     * 发送提示词并等待生成完成
     * @param {string} prompt
     * @param {object} [opts]
     * @param {number} [opts.timeout=120000]
     * @param {number} [opts.interval=8000]
     * @param {(status: object) => void} [opts.onPoll]
     * @returns {Promise<{ok: boolean, elapsed: number, finalStatus?: object, error?: string}>}
     */
    async sendAndWait(prompt, opts = {}) {
      const {
        timeout = 120_000,
        interval = 1_000,
        onPoll,
        preSendDelay = 300,
      } = opts;
      const start = Date.now();
      const deadline = start + Math.max(0, timeout);

      if (page?.isClosed?.()) return { ok: false, error: 'page_closed', elapsed: 0 };

      let initialStatus;
      try {
        initialStatus = await this.getStatus();
      } catch (error) {
        return { ok: false, error: page?.isClosed?.() ? 'page_closed' : 'status_unavailable', detail: error.message, elapsed: Date.now() - start };
      }
      if (initialStatus.status === 'stop') {
        return { ok: false, error: 'previous_generation_active', finalStatus: initialStatus, elapsed: Date.now() - start };
      }
      if (!['mic', 'submit'].includes(initialStatus.status)) {
        return { ok: false, error: 'answer_state_unknown', finalStatus: initialStatus, elapsed: Date.now() - start };
      }

      // Take the turn/image baseline before touching the composer. This is
      // intentionally scoped to model response nodes, not user attachments.
      let baseline;
      try {
        baseline = await this.getResponseSnapshot();
      } catch (error) {
        return { ok: false, error: page?.isClosed?.() ? 'page_closed' : 'page_changed', detail: error.message, elapsed: Date.now() - start };
      }
      if (!baseline?.ok) return { ok: false, error: baseline?.error || 'response_snapshot_failed', elapsed: Date.now() - start };

      // Recheck immediately before filling: the page may still be finishing a
      // previous request whose browser session lease has already been released.
      try {
        initialStatus = await this.getStatus();
      } catch (error) {
        return { ok: false, error: page?.isClosed?.() ? 'page_closed' : 'status_unavailable', detail: error.message, elapsed: Date.now() - start };
      }
      if (initialStatus.status === 'stop') {
        return { ok: false, error: 'previous_generation_active', finalStatus: initialStatus, elapsed: Date.now() - start };
      }
      if (!['mic', 'submit'].includes(initialStatus.status)) {
        return { ok: false, error: 'answer_state_unknown', finalStatus: initialStatus, elapsed: Date.now() - start };
      }

      let fillResult;
      try {
        fillResult = await this.fillPrompt(prompt);
      } catch (error) {
        return { ok: false, error: page?.isClosed?.() ? 'page_closed' : 'fill_failed', detail: error.message, elapsed: Date.now() - start };
      }
      if (!fillResult.ok) {
        return { ok: false, error: 'fill_failed', detail: fillResult, elapsed: Date.now() - start };
      }
      if (Date.now() >= deadline) return { ok: false, error: 'timeout', elapsed: Date.now() - start };
      await sleep(Math.min(preSendDelay, Math.max(0, deadline - Date.now())));

      let clickReadyStatus;
      try {
        clickReadyStatus = await this.getStatus();
      } catch (error) {
        return { ok: false, error: page?.isClosed?.() ? 'page_closed' : 'status_unavailable', detail: error.message, elapsed: Date.now() - start };
      }
      if (clickReadyStatus.status === 'stop') {
        return { ok: false, error: 'previous_generation_active', finalStatus: clickReadyStatus, elapsed: Date.now() - start };
      }
      if (clickReadyStatus.status !== 'submit') {
        return { ok: false, error: 'send_not_ready', finalStatus: clickReadyStatus, elapsed: Date.now() - start };
      }
      let beforeClickSnapshot;
      try {
        beforeClickSnapshot = await this.getResponseSnapshot();
      } catch (error) {
        return { ok: false, error: page?.isClosed?.() ? 'page_closed' : 'page_changed', detail: error.message, elapsed: Date.now() - start };
      }
      if (beforeClickSnapshot?.pageKey !== baseline.pageKey) {
        return { ok: false, error: 'page_changed', elapsed: Date.now() - start };
      }
      if (Date.now() >= deadline) return { ok: false, error: 'timeout', elapsed: Date.now() - start };

      let clickResult;
      try {
        clickResult = await this.click('sendBtn');
      } catch (error) {
        return { ok: false, error: page?.isClosed?.() ? 'page_closed' : 'send_click_failed', detail: error.message, elapsed: Date.now() - start };
      }
      console.log(`[ops] 发送按钮点击结果:`, clickResult);
      if (!clickResult.ok) {
        return { ok: false, error: 'send_click_failed', detail: clickResult, elapsed: Date.now() - start };
      }

      let lastStatus = null;
      let selectedIndex = null;
      let stableFingerprint = null;
      let stableSamples = 0;
      let acceptedPageKey = null;

      while (Date.now() < deadline) {
        if (page?.isClosed?.()) return { ok: false, error: 'page_closed', elapsed: Date.now() - start, finalStatus: lastStatus };
        if (interval > 0) await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));

        let poll;
        let snapshot;
        try {
          poll = await this.pollStatus();
          snapshot = await this.getResponseSnapshot();
        } catch (error) {
          return { ok: false, error: page?.isClosed?.() ? 'page_closed' : 'page_changed', detail: error.message, elapsed: Date.now() - start, finalStatus: lastStatus };
        }
        lastStatus = poll;
        onPoll?.(poll);

        const selected = findNewResponse(baseline, snapshot, { prompt, acceptedPageKey });
        if (selected?.error) {
          return { ok: false, error: selected.error, elapsed: Date.now() - start, finalStatus: poll };
        }
        if (selected?.pendingPageKey) acceptedPageKey = selected.pendingPageKey;

        if (selected?.response) {
          selectedIndex = selected.index;
          const fingerprint = responseFingerprint(selected.response);
          acceptedPageKey = selected.pageKey || acceptedPageKey;
          if (poll.status !== 'mic' || selected.response.loader) {
            stableFingerprint = fingerprint;
            stableSamples = 0;
            continue;
          }

          if (fingerprint === stableFingerprint) stableSamples++;
          else {
            stableFingerprint = fingerprint;
            stableSamples = 1;
          }

          // Require the same new response on two non-generating observations.
          // This handles fast replies that never expose the stop button while
          // avoiding success on an old answer merely because the mic is idle.
          if (stableSamples >= 2) {
            return {
              ok: true,
              elapsed: Date.now() - start,
              finalStatus: poll,
              text: selected.response.text || null,
              textIndex: selected.index,
              responseIndex: selected.index,
              responseIdentity: selected.response.identity,
              responsePageKey: acceptedPageKey || baseline.pageKey,
              responseImageBaseline: baseline.imageSources || [],
            };
          }
        } else {
          stableFingerprint = null;
          stableSamples = 0;
        }

        if (poll.status === 'unknown') console.warn('[ops] unknown status, may need screenshot to debug');
      }

      return { ok: false, error: 'timeout', elapsed: Date.now() - start, finalStatus: lastStatus, responseIndex: selectedIndex };
    },

    /**
     * 完整生图流程：发送提示词 → 等待 → 提取图片
     * 注意：新建会话、上传参考图等前置操作由调用方负责
     * @param {string} prompt
     * @param {object} [opts]
     * @param {number} [opts.timeout=120000]
     * @param {boolean} [opts.fullSize=false] - true 时通过 CDP 拦截下载完整尺寸原图到 outputDir；false 时提取页面预览图 base64
     * @param {(status: object) => void} [opts.onPoll]
     */
    async generateImage(prompt, opts = {}) {
      const { timeout = 120_000, fullSize = false, onPoll, interval = 1_000, preSendDelay } = opts;

      // 1. 发送并等待
      const waitResult = await this.sendAndWait(prompt, { timeout, interval, preSendDelay, onPoll });
      if (!waitResult.ok) {
        return { ...waitResult, step: 'sendAndWait' };
      }

      // A complete text-only response has no image descendants. For image
      // responses, keep polling that response's own nodes until an actual
      // image load is complete; never fall back to the page's historical tail.
      const deadline = Date.now() + Math.max(0, timeout - (waitResult.elapsed || 0));
      const baselineSources = new Set(waitResult.responseImageBaseline || []);
      let imgInfo = null;
      let lastImageState = null;
      while (Date.now() <= deadline) {
        if (page?.isClosed?.()) return { ok: false, error: 'page_closed', step: 'getResponseImages', elapsed: waitResult.elapsed };
        try {
          lastImageState = await this.getResponseImages({
            index: waitResult.responseIndex,
            identity: waitResult.responseIdentity,
            pageKey: waitResult.responsePageKey,
          });
        } catch (error) {
          return { ok: false, error: page?.isClosed?.() ? 'page_closed' : 'page_changed', detail: error.message, step: 'getResponseImages', elapsed: waitResult.elapsed };
        }
        if (!lastImageState?.ok) {
          return { ok: false, error: lastImageState?.error || 'page_changed', step: 'getResponseImages', elapsed: waitResult.elapsed };
        }

        const newImages = (lastImageState.images || []).filter(image => image.src && !baselineSources.has(image.src));
        const candidate = newImages.at(-1);
        if (candidate?.loaded && candidate.width > 0) {
          imgInfo = { ok: true, ...candidate, isNew: true };
          break;
        }
        if (!candidate && !lastImageState.loader) {
          return { ok: false, error: 'NO_NEW_IMAGE', elapsed: waitResult.elapsed, responseIndex: waitResult.responseIndex, responseText: waitResult.text };
        }
        if (Date.now() >= deadline) break;
        await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
      }
      if (!imgInfo) {
        return {
          ok: false,
          error: 'image_load_timeout',
          elapsed: waitResult.elapsed,
          responseIndex: waitResult.responseIndex,
          image: lastImageState?.images?.at(-1) || null,
        };
      }

      // 5. 提取 / 下载
      if (fullSize) {
        // 完整尺寸下载：通过 CDP 拦截，文件保存到 config.outputDir
        const dlResult = await this.downloadFullSizeImage({
          index: imgInfo.index,
          imageUrl: imgInfo.src,
          timeout: Math.max(1, deadline - Date.now()),
        });
        return { ok: dlResult.ok, method: 'fullSize', elapsed: waitResult.elapsed, ...dlResult };
      } else {
        // 低分辨率：提取页面预览图的 base64
        const b64Result = await this.extractImageBase64(imgInfo.src);
        return { ok: b64Result.ok, method: b64Result.method, elapsed: waitResult.elapsed, ...b64Result };
      }
    },

    /** 底层 page 引用 */
    get page() {
      return page;
    },

    /**
     * 检查是否已登录 Google 账号
     *
     * @returns {Promise<{ok: boolean, loggedIn: boolean, barText?: string, error?: string}>}
     */
    async checkLogin() {
      return isLoggedIn(op);
    },
  };
}

/**
 * 判断侧边栏是否处于展开状态（内部工具函数，不对外暴露）
 *
 * 通过 overflow-container 元素的实际渲染宽度判断：
 *   - width >= 100px → 展开
 *   - width <  100px → 折叠
 *
 * @param {ReturnType<typeof createOperator>} op
 * @returns {Promise<{ok: boolean, expanded: boolean, width: number, error?: string}>}
 */
function isSidebarExpanded(op) {
  return op.query((sels) => {
    let el = null;
    for (const sel of sels) {
      try { el = document.querySelector(sel); } catch { /* skip */ }
      if (el) break;
    }
    if (!el) {
      return { ok: false, expanded: false, width: 0, error: 'sidebar_container_not_found' };
    }
    const width = el.getBoundingClientRect().width;
    return { ok: true, expanded: width >= 100, width };
  }, SELECTORS.sidebarContainer);
}

/**
 * 检查生成的图片是否加载完成
 *
 * 判断依据：页面中是否存在 div.loader.animate 元素。
 * 存在 → 图片还在加载；不存在 → 加载完毕。
 *
 * @param {ReturnType<typeof createOperator>} op
 * @returns {Promise<{loaded: boolean}>}
 */
function isImageLoaded(op) {
  return op.query(() => {
    const loader = document.querySelector('div.loader.animate');
    return { loaded: !loader };
  });
}

/**
 * 检查是否已登录 Google 账号
 *
 * 只有明确登录提示或可见 Gemini 编辑器才判定登录状态；空导航栏及未知 UI 不作为登录证据。
 *
 * @param {ReturnType<typeof createOperator>} op
 * @returns {Promise<{ok: boolean, loggedIn: boolean, barText?: string, error?: string}>}
 */
function isLoggedIn(op) {
  return op.query((editorSelectors) => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const bar = document.querySelector('div.boqOnegoogleliteOgbOneGoogleBar');
    const text = (bar?.innerText || '').trim();
    let hostname = '';
    let pathname = '';
    try {
      const url = new URL(location.href);
      hostname = url.hostname;
      pathname = url.pathname;
    } catch { /* Classify missing URL as an unready page below. */ }
    if (hostname === 'accounts.google.com') {
      const authError = /unknownerror/i.test(pathname);
      return {
        ok: true,
        loggedIn: false,
        state: authError ? 'auth_error' : 'login_required',
        error: authError ? 'authentication_error' : 'login_required',
        barText: text,
      };
    }

    const loginControls = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"]')];
    const loginButtonVisible = loginControls.some((el) => {
      if (!isVisible(el)) return false;
      const label = `${el.innerText || el.textContent || ''} ${el.getAttribute?.('aria-label') || ''} ${el.value || ''}`;
      return /sign\s*in|log\s*in|登录|登入/i.test(label);
    });
    const visibleText = (document.body?.innerText || '').replace(/[\t\r\n ]+/g, ' ').trim();
    if (loginButtonVisible || /sign\s*in|log\s*in|登录|登入/i.test(`${text} ${visibleText}`)) {
      return { ok: true, loggedIn: false, state: 'login_required', error: 'login_required', barText: text };
    }

    let editorVisible = false;
    for (const selector of editorSelectors) {
      try {
        if ([...document.querySelectorAll(selector)].some(isVisible)) {
          editorVisible = true;
          break;
        }
      } catch { /* Ignore unsupported selectors. */ }
    }
    if (editorVisible) {
      return { ok: true, loggedIn: true, state: 'ready', barText: text };
    }

    const state = bar || hostname === 'gemini.google.com' ? 'page_not_ready' : 'unsupported_ui';
    return {
      ok: false,
      loggedIn: false,
      state,
      error: state,
      barText: text,
    };
  }, SELECTORS.promptInput);
}

/**
 * 规范化 Gemini 分享链接
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeShareLink(raw) {
  if (!raw) return '';

  const trimmed = raw.trim();
  if (!trimmed) return '';

  if (/^https:\/\/gemini\.google\.com\/share\/[A-Za-z0-9_-]+$/i.test(trimmed)) {
    return trimmed;
  }

  if (/^gemini\.google\.com\/share\/[A-Za-z0-9_-]+$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return '';
}

/**
 * 从文本中提取 Gemini 分享链接
 *
 * @param {string} text
 * @returns {string}
 */
function extractShareLinkFromText(text) {
  if (!text) return '';

  const match = text.match(/(?:https?:\/\/)?gemini\.google\.com\/share\/[A-Za-z0-9_-]+/i);
  if (!match) return '';

  return normalizeShareLink(match[0]);
}
