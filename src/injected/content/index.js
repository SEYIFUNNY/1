import bridge, { addBackgroundHandlers, addHandlers, onScripts } from './bridge';
import { onClipboardCopy } from './clipboard';
import { sendSetPopup } from './gm-api-content';
import { injectPageSandbox, injectScripts } from './inject';
import './notifications';
import './requests';
import './tabs';
import { sendCmd } from './util';
import { isEmpty } from '../util';
import { Run } from './cmd-run';

const { ids } = bridge;

// Make sure to call obj::method() in code that may run after INJECT_CONTENT userscripts
async function init() {
  const isXml = document instanceof XMLDocument;
  const xhrData = getXhrInjection();
  const dataPromise = sendCmd('GetInjected', {
    /* In FF93 sender.url is wrong: https://bugzil.la/1734984,
     * in Chrome sender.url is ok, but location.href is wrong for text selection URLs #:~:text= */
    url: IS_FIREFOX && location.href,
    // XML document's appearance breaks when script elements are added
    [INJECT_CONTENT_FORCE]: isXml,
    done: !!(xhrData || global.vmData),
  }, {
    retry: true,
  });
  // detecting if browser.contentScripts is usable, it was added in FF59 as well as composedPath
  /** @type {VMInjection} */
  const data = xhrData || (
    IS_FIREFOX && Event[PROTO].composedPath
      ? await getDataFF(dataPromise)
      : await dataPromise
  );
  assign(ids, data.ids);
  bridge[INJECT_INTO] = data[INJECT_INTO];
  if (data.expose && !isXml && injectPageSandbox(data)) {
    addHandlers({ GetScriptVer: true });
    bridge.post('Expose');
  }
  if (IS_FIREFOX && !data.clipFF) {
    off('copy', onClipboardCopy, true);
  }
  if (data.scripts) {
    onScripts.forEach(fn => fn(data));
    await injectScripts(data, isXml);
  }
  onScripts.length = 0;
  sendSetPopup();
}

addBackgroundHandlers({
  Command: data => bridge.post('Command', data, ids[data.id]),
  Run: id => Run(id, INJECT_CONTENT),
  UpdatedValues(data) {
    const dataPage = createNullObj();
    const dataContent = createNullObj();
    objectKeys(data)::forEach((id) => {
      (ids[id] === INJECT_CONTENT ? dataContent : dataPage)[id] = data[id];
    });
    if (!isEmpty(dataPage)) bridge.post('UpdatedValues', dataPage);
    if (!isEmpty(dataContent)) bridge.post('UpdatedValues', dataContent, INJECT_CONTENT);
  },
});

addHandlers({
  TabFocus: true,
  UpdateValue: true,
});

init().catch(IS_FIREFOX && console.error); // Firefox can't show exceptions in content scripts

async function getDataFF(viaMessaging) {
  const data = self.vmData || await SafePromise.race([
    new SafePromise(resolve => { self.vmResolve = resolve; }),
    viaMessaging,
  ]);
  delete self.vmResolve;
  delete self.vmData;
  return data;
}

function getXhrInjection() {
  try {
    const quotedKey = `"${INIT_FUNC_NAME}"`;
    // Accessing document.cookie may throw due to CSP sandbox
    const cookieValue = document.cookie.split(`${quotedKey}=`)[1];
    const blobId = cookieValue && cookieValue.split(';', 1)[0];
    if (blobId) {
      document.cookie = `${quotedKey}=0; max-age=0; SameSite=Lax`; // this removes our cookie
      const xhr = new XMLHttpRequest();
      const url = `blob:${VM_UUID}${blobId}`;
      xhr.open('get', url, false); // `false` = synchronous
      xhr.send();
      URL.revokeObjectURL(url);
      return JSON.parse(xhr[kResponse]);
    }
  } catch { /* NOP */ }
}
