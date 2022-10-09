import '@/common/browser';
import { getActiveTab, makePause, sendCmd } from '@/common';
import { TIMEOUT_24HOURS, TIMEOUT_MAX, extensionRoot, extensionOrigin } from '@/common/consts';
import { deepCopy } from '@/common/object';
import * as tld from '@/common/tld';
import * as sync from './sync';
import { addOwnCommands, addPublicCommands, commands } from './utils';
import { getData, getSizes, checkRemove } from './utils/db';
import { initialize } from './utils/init';
import { getOption, hookOptions } from './utils/options';
import './utils/clipboard';
import './utils/hotkeys';
import './utils/icon';
import './utils/notifications';
import './utils/preinject';
import './utils/script';
import './utils/tabs';
import './utils/tab-redirector';
import './utils/tester';
import './utils/update';

hookOptions((changes) => {
  if ('autoUpdate' in changes) {
    autoUpdate();
  }
  sendCmd('UpdateOptions', changes);
});

addOwnCommands({
  async GetData(opts) {
    const data = await getData(opts);
    data.sync = sync.getStates();
    return data;
  },
  GetSizes: getSizes,
  /** @return {Promise<Object>} */
  async GetTabDomain() {
    const tab = await getActiveTab() || {};
    const url = tab.pendingUrl || tab.url || '';
    const host = url.match(/^https?:\/\/([^/]+)|$/)[1];
    return {
      tab,
      domain: host && tld.getDomain(host) || host,
    };
  },
});

addPublicCommands({
  /**
   * Timers in content scripts are shared with the web page so it can clear them.
   * await sendCmd('SetTimeout', 100) in injected/content
   * bridge.call('SetTimeout', 100, cb) in injected/web
   */
  SetTimeout(ms) {
    return ms > 0 && makePause(ms);
  },
});

// commands to sync unconditionally regardless of the returned value from the handler
const commandsToSync = [
  'MarkRemoved',
  'Move',
  'ParseScript',
  'RemoveScript',
  'UpdateScriptInfo',
];
// commands to sync only if the handler returns a truthy value
const commandsToSyncIfTruthy = [
  'CheckRemove',
  'CheckUpdate',
];

async function handleCommandMessage({ cmd, data } = {}, src) {
  const func = commands::hasOwnProperty(cmd) && commands[cmd];
  if (!func) {
    throw new SafeError(`Unknown command: ${cmd}`);
  }
  // The `src` is omitted when invoked via sendCmdDirectly unless fakeSrc is set.
  // The `origin` is Chrome-only, it can't be spoofed by a compromised tab unlike `url`.
  if (func.isOwn && src && !src.fake
  && (src.origin ? src.origin !== extensionOrigin : !`${src.url}`.startsWith(extensionRoot))) {
    throw new SafeError(`Command is only allowed in extension context: ${cmd}`);
  }
  try {
    const res = await func(data, src);
    if (commandsToSync.includes(cmd)
    || res && commandsToSyncIfTruthy.includes(cmd)) {
      sync.sync();
    }
    // `undefined` is not transferable, but `null` is
    return res ?? null;
  } catch (err) {
    // Adding `stack` info + in FF a rejected Promise value is transferred only for an Error object
    throw err instanceof SafeError ? err : new SafeError(err);
  }
}

function autoUpdate() {
  const interval = (+getOption('autoUpdate') || 0) * TIMEOUT_24HOURS;
  if (!interval) return;
  let elapsed = Date.now() - getOption('lastUpdate');
  if (elapsed >= interval) {
    handleCommandMessage({ cmd: 'CheckUpdate' });
    elapsed = 0;
  }
  clearTimeout(autoUpdate.timer);
  autoUpdate.timer = setTimeout(autoUpdate, Math.min(TIMEOUT_MAX, interval - elapsed));
}

initialize(() => {
  global.handleCommandMessage = handleCommandMessage;
  global.deepCopy = deepCopy;
  browser.runtime.onMessage.addListener(handleCommandMessage);
  setTimeout(autoUpdate, 2e4);
  sync.initialize();
  checkRemove();
  setInterval(checkRemove, TIMEOUT_24HOURS);
  const api = global.chrome.declarativeContent;
  if (api) {
    // Using declarativeContent to run content scripts earlier than document_start
    api.onPageChanged.getRules(/* for old Chrome */ null, async ([rule]) => {
      const id = rule?.id;
      const newId = process.env.INIT_FUNC_NAME;
      if (id === newId) {
        return;
      }
      if (id) {
        await browser.declarativeContent.onPageChanged.removeRules([id]);
      }
      api.onPageChanged.addRules([{
        id: newId,
        conditions: [
          new api.PageStateMatcher({
            pageUrl: { urlContains: '://' }, // essentially like <all_urls>
          }),
        ],
        actions: [
          new api.RequestContentScript({
            js: browser.runtime.getManifest().content_scripts[0].js,
            // Not using `allFrames:true` as there's no improvement in frames
          }),
        ],
      }]);
    });
  }
});
