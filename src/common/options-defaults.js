import { INJECT_AUTO } from './consts';

export default {
  isApplied: true,
  autoUpdate: 1, // days, 0 = disable
  // ignoreGrant: false,
  lastUpdate: 0,
  lastModified: 0,
  /** @type {VM.BadgeMode} */
  showBadge: 'unique',
  badgeColor: '#880088',
  badgeColorBlocked: '#888888',
  exportValues: true,
  exportNameTemplate: '[violentmonkey]_YYYY-MM-DD_HH.mm.ss',
  expose: { // use percent-encoding for '.'
    'greasyfork%2Eorg': true,
    'sleazyfork%2Eorg': false,
  },
  closeAfterInstall: false,
  trackLocalFile: false,
  autoReload: false,
  features: null,
  blacklist: null,
  syncScriptStatus: true,
  sync: null,
  customCSS: '',
  importScriptData: true,
  importSettings: true,
  notifyUpdates: false,
  notifyUpdatesGlobal: false, // `true` ignores script.config.notifyUpdates
  version: null,
  /** @type {VMScriptInjectInto} */
  defaultInjectInto: INJECT_AUTO,
  xhrInject: false,
  filters: {
    /** @type {'name' | 'code' | 'all'} */
    searchScope: 'name',
    /** @type {boolean} */
    showOrder: false,
    /** @type {'exec' | 'alpha' | 'update'} */
    sort: 'exec',
    /** @type {boolean} */
    viewSingleColumn: false,
    /** @type {boolean} */
    viewTable: false,
  },
  filtersPopup: {
    /** @type {'exec' | 'alpha'} */
    sort: 'exec',
    enabledFirst: false,
    /** @type {'' | 'hide' | 'group'} where '' = show */
    hideDisabled: '',
  },
  editor: {
    lineWrapping: false,
    indentWithTabs: false,
    indentUnit: 2,
    tabSize: 2,
    undoDepth: 500,
  },
  editorTheme: '',
  editorThemeName: null,
  editorWindow: false, // whether popup opens editor in a new window
  editorWindowPos: {}, // { left, top, width, height }
  editorWindowSimple: true, // whether to open a simplified popup or a normal browser window
  scriptTemplate: `\
// ==UserScript==
// @name        New script {{name}}
// @namespace   Violentmonkey Scripts
// @match       {{url}}
// @grant       none
// @version     1.0
// @author      -
// @description {{date}}
// ==/UserScript==
`,
  showAdvanced: true,
  /** @type {'' | 'dark' | 'light'} */
  uiTheme: '',
};
