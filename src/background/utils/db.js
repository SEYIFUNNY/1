import {
  compareVersion, dataUri2text, i18n, getScriptHome, isDataUri, makeDataUri,
  getFullUrl, getScriptName, getScriptUpdateUrl, isRemote, sendCmd, trueJoin,
  getScriptPrettyUrl, makePause,
} from '@/common';
import { ICON_PREFIX, INFERRED, INJECT_PAGE, INJECT_AUTO, TIMEOUT_WEEK } from '@/common/consts';
import { deepSize, forEachEntry, forEachKey, forEachValue } from '@/common/object';
import pluginEvents from '../plugin/events';
import { getDefaultCustom, getNameURI, inferScriptProps, newScript, parseMeta } from './script';
import { testScript, testBlacklist, testerBatch } from './tester';
import { preInitialize } from './init';
import { addOwnCommands, addPublicCommands, commands } from './message';
import patchDB from './patch-db';
import { setOption } from './options';
import storage, {
  S_CACHE, S_CODE, S_REQUIRE, S_VALUE,
  S_CACHE_PRE, S_CODE_PRE, S_MOD_PRE, S_REQUIRE_PRE, S_SCRIPT_PRE, S_VALUE_PRE,
} from './storage';

export const store = {
  /** @type {VMScript[]} */
  scripts: [],
  /** @type {Object<string,VMScript[]>} */
  scriptMap: {},
  /** @type {{ [url:string]: number }} */
  sizes: {},
  /** Same order as in SIZE_TITLES and getSizes */
  sizesPrefixRe: RegExp(`^(${S_CODE_PRE}|${S_SCRIPT_PRE}|${S_VALUE_PRE}|${S_REQUIRE_PRE}|${S_CACHE_PRE}${S_MOD_PRE})`),
  storeInfo: {
    id: 0,
    position: 0,
  },
};

addPublicCommands({
  GetScriptVer(opts) {
    const script = getScript(opts);
    return script && !script.config.removed
      ? script.meta.version
      : null;
  },
});

addOwnCommands({
  CheckPosition: sortScripts,
  CheckRemove: checkRemove,
  /** @return {VMScript} */
  GetScript: getScript,
  /** @return {Promise<{ items: VMScript[], values? }>} */
  async ExportZip({ values }) {
    const scripts = getScripts();
    const ids = scripts.map(getPropsId);
    const codeMap = await storage.code.getMulti(ids);
    return {
      items: scripts.map(script => ({ script, code: codeMap[script.props.id] })),
      values: values ? await storage.value.getMulti(ids) : undefined,
    };
  },
  /** @return {Promise<string>} */
  GetScriptCode(id) {
    return storage.code[Array.isArray(id) ? 'getMulti' : 'getOne'](id);
  },
  /** @return {Promise<void>} */
  MarkRemoved({ id, removed }) {
    return updateScriptInfo(id, {
      config: { removed: removed ? 1 : 0 },
      props: { lastModified: Date.now() },
    });
  },
  /** @return {Promise<number>} */
  Move({ id, offset }) {
    const script = getScriptById(id);
    const index = store.scripts.indexOf(script);
    store.scripts.splice(index, 1);
    store.scripts.splice(index + offset, 0, script);
    return normalizePosition();
  },
  /** @return {Promise<void>} */
  async RemoveScript(id) {
    const i = store.scripts.indexOf(getScriptById(id));
    if (i >= 0) {
      store.scripts.splice(i, 1);
      await storage.base.remove([
        storage.script.toKey(id),
        storage.code.toKey(id),
        storage.value.toKey(id),
      ]);
    }
    return sendCmd('RemoveScript', id);
  },
  ParseMeta: parseMetaWithErrors,
  ParseScript: parseScript,
  /** @return {Promise<void>} */
  UpdateScriptInfo({ id, config, custom }) {
    return updateScriptInfo(id, {
      config,
      custom,
      props: { lastModified: Date.now() },
    });
  },
  /** @return {Promise<number>} */
  Vacuum: vacuum,
});

preInitialize.push(async () => {
  const lastVersion = await storage.base.getOne('version');
  const version = process.env.VM_VER;
  if (!lastVersion) await patchDB();
  if (version !== lastVersion) storage.base.set({ version });
  const data = await storage.base.getMulti();
  const { scripts, storeInfo, scriptMap } = store;
  const uriMap = {};
  data::forEachEntry(([key, script]) => {
    const id = +storage.script.toId(key);
    if (id && script) {
      if (scriptMap[id] && scriptMap[id] !== script) {
        // ID conflicts!
        // Should not happen, discard duplicates.
        return;
      }
      const uri = getNameURI(script);
      if (uriMap[uri]) {
        // Namespace conflicts!
        // Should not happen, discard duplicates.
        return;
      }
      uriMap[uri] = script;
      script.props = {
        ...script.props,
        id,
        uri,
      };
      script.custom = {
        ...getDefaultCustom(),
        ...script.custom,
      };
      storeInfo.id = Math.max(storeInfo.id, id);
      storeInfo.position = Math.max(storeInfo.position, getInt(script.props.position));
      scripts.push(script);
      // listing all known resource urls in order to remove unused mod keys
      const {
        meta = script.meta = {},
      } = script;
      if (!meta.require) meta.require = [];
      if (!meta.resources) meta.resources = {};
      meta.grant = [...new Set(meta.grant || [])]; // deduplicate
    }
  });
  // Switch defaultInjectInto from `page` to `auto` when upgrading VM2.12.7 or older
  if (version !== lastVersion
  && IS_FIREFOX
  && data.options?.defaultInjectInto === INJECT_PAGE
  && compareVersion(lastVersion, '2.12.7') <= 0) {
    setOption('defaultInjectInto', INJECT_AUTO);
  }
  if (process.env.DEBUG) {
    console.log('store:', store); // eslint-disable-line no-console
  }
  sortScripts();
  vacuum(data);
});

/** @return {number} */
function getInt(val) {
  return +val || 0;
}

/** @return {?number} */
function getPropsId(script) {
  return script?.props.id;
}

/** @return {void} */
function updateLastModified() {
  setOption('lastModified', Date.now());
}

/** @return {Promise<boolean>} */
export async function normalizePosition() {
  const updates = store.scripts.reduce((res, script, index) => {
    const { props } = script;
    const position = index + 1;
    if (props.position !== position) {
      props.position = position;
      (res || (res = {}))[props.id] = script;
    }
    return res;
  }, null);
  store.storeInfo.position = store.scripts.length;
  if (updates) {
    await storage.script.set(updates);
    updateLastModified();
  }
  return !!updates;
}

/** @return {Promise<number>} */
export async function sortScripts() {
  store.scripts.sort((a, b) => getInt(a.props.position) - getInt(b.props.position));
  const changed = await normalizePosition();
  sendCmd('ScriptsUpdated', null);
  return changed;
}

/** @return {?VMScript} */
export function getScriptById(id) {
  return store.scriptMap[id];
}

/** @return {?VMScript} */
export function getScript({ id, uri, meta }) {
  let script;
  if (id) {
    script = getScriptById(id);
  } else {
    if (!uri) uri = getNameURI({ meta, id: '@@should-have-name' });
    script = store.scripts.find(({ props }) => uri === props.uri);
  }
  return script;
}

/** @return {VMScript[]} */
export function getScripts() {
  return store.scripts.filter(script => !script.config.removed);
}

export const ENV_CACHE_KEYS = 'cacheKeys';
export const ENV_REQ_KEYS = 'reqKeys';
export const ENV_SCRIPTS = 'scripts';
export const ENV_VALUE_IDS = 'valueIds';
const GMVALUES_RE = /^GM[_.](listValues|([gs]et|delete)Value)$/;
const RUN_AT_RE = /^document-(start|body|end|idle)$/;
const STORAGE_ROUTES = {
  [S_CACHE]: ENV_CACHE_KEYS,
  [S_CODE]: 'ids',
  [S_REQUIRE]: ENV_REQ_KEYS,
  [S_VALUE]: ENV_VALUE_IDS,
};
const STORAGE_ROUTES_ENTRIES = Object.entries(STORAGE_ROUTES);
const notifiedBadScripts = new Set();

/**
 * @desc Get scripts to be injected to page with specific URL.
 */
export function getScriptsByURL(url, isTop, errors) {
  testerBatch(errors || true);
  const allScripts = testBlacklist(url)
    ? []
    : store.scripts.filter(script => (
      !script.config.removed
      && (isTop || !(script.custom.noframes ?? script.meta.noframes))
      && testScript(url, script)
    ));
  testerBatch();
  return getScriptEnv(allScripts);
}

/**
 * @param {VMScript[]} scripts
 * @return {Promise<VMInjection.Env>}
 */
async function getScriptEnv(scripts) {
  const allIds = {};
  const [envStart, envDelayed] = [0, 1].map(() => ({
    depsMap: {},
    [ENV_SCRIPTS]: [],
  }));
  for (const [areaName, listName] of STORAGE_ROUTES_ENTRIES) {
    envStart[areaName] = {}; envDelayed[areaName] = {};
    envStart[listName] = []; envDelayed[listName] = [];
  }
  scripts.forEach((script) => {
    const { id } = script.props;
    if (!(allIds[id] = +!!script.config.enabled)) {
      return;
    }
    const { meta, custom } = script;
    const { pathMap = buildPathMap(script) } = custom;
    const runAt = `${custom.runAt || meta.runAt || ''}`.match(RUN_AT_RE)?.[1] || 'end';
    /** @type {VMInjection.Env} */
    const env = runAt === 'start' || runAt === 'body' ? envStart : envDelayed;
    const { depsMap } = env;
    env.ids.push(id);
    if (meta.grant.some(GMVALUES_RE.test, GMVALUES_RE)) {
      env[ENV_VALUE_IDS].push(id);
    }
    for (const [list, name, dataUriDecoder] of [
      [meta.require, S_REQUIRE, dataUri2text],
      [Object.values(meta.resources), S_CACHE],
    ]) {
      const listName = STORAGE_ROUTES[name];
      const envCheck = name === S_CACHE ? envStart : env; // envStart cache is reused in injected
      for (let url of list) {
        url = pathMap[url] || url;
        if (url) {
          if (isDataUri(url)) {
            if (dataUriDecoder) {
              env[name][url] = dataUriDecoder(url);
            }
          } else if (!envCheck[listName].includes(url)) {
            env[listName].push(url);
            (depsMap[url] || (depsMap[url] = [])).push(id);
          }
        }
      }
    }
    env[ENV_SCRIPTS].push({ ...script, runAt }); // must be a copy because we modify it in preinject
  });
  if (envStart.ids.length) {
    Object.assign(envStart, await readEnvironmentData(envStart));
  }
  if (envDelayed.ids.length) {
    envDelayed.promise = makePause().then(() => readEnvironmentData(envDelayed));
  }
  return Object.assign(envStart, { allIds, envDelayed });
}

async function readEnvironmentData(env) {
  const keys = [];
  for (const [area, listName] of STORAGE_ROUTES_ENTRIES) {
    for (const id of env[listName]) {
      keys.push(storage[area].toKey(id));
    }
  }
  const data = await storage.base.getMulti(keys);
  const badScripts = new Set();
  for (const [area, listName] of STORAGE_ROUTES_ENTRIES) {
    for (const id of env[listName]) {
      let val = data[storage[area].toKey(id)];
      if (!val && area === S_VALUE) val = {};
      env[area][id] = val;
      if (val == null) {
        if (area === S_CODE) {
          badScripts.add(id);
        } else {
          env.depsMap[id]?.forEach(scriptId => badScripts.add(scriptId));
        }
      }
    }
  }
  if (badScripts.size) {
    reportBadScripts(badScripts);
  }
  return env;
}

/** @param {Set<number>} ids */
function reportBadScripts(ids) {
  const unnotifiedIds = [];
  const title = i18n('msgMissingResources');
  let toLog = i18n('msgReinstallScripts');
  let toNotify = toLog;
  let str;
  ids.forEach(id => {
    str = `\n#${id}: ${getScriptName(getScriptById(id))}`;
    toLog += str;
    if (!notifiedBadScripts.has(id)) {
      notifiedBadScripts.add(id);
      unnotifiedIds.push(id);
      toNotify += str;
    }
  });
  console.error(`${title} ${toLog}`);
  if (unnotifiedIds.length) {
    commands.Notification({ title, text: toNotify }, undefined, {
      onClick() {
        unnotifiedIds.forEach(id => commands.OpenEditor(id));
      },
    });
  }
}

/**
 * @desc Get data for dashboard.
 * @return {Promise<{ scripts: VMScript[], cache: Object }>}
 */
export async function getData({ ids, sizes }) {
  const scripts = ids ? ids.map(getScriptById) : store.scripts;
  scripts.forEach(inferScriptProps);
  return {
    scripts,
    cache: await getIconCache(scripts),
    sizes: sizes && getSizes(ids),
  };
}

/**
 * @param {VMScript[]} scripts
 * @return {Promise<{}>}
 */
async function getIconCache(scripts) {
  const urls = [];
  for (const { custom, meta: { icon } } of scripts) {
    if (isRemote(icon)) {
      urls.push(custom.pathMap[icon] || icon);
    }
  }
  // Getting a data uri for own icon to load it instantly in Chrome when there are many images
  const ownPath = `${ICON_PREFIX}38.png`;
  const [res, ownUri] = await Promise.all([
    storage.cache.getMulti(urls, makeDataUri),
    commands.GetImageData(ownPath),
  ]);
  res[ownPath] = ownUri;
  return res;
}

/**
 * @param {number[]} [ids]
 * @return {number[][]}
 */
export function getSizes(ids) {
  const scripts = ids ? ids.map(getScriptById) : store.scripts;
  return scripts.map(({
    meta,
    custom: { pathMap = {} },
    props: { id },
  }, i) => [
    // Same order as SIZE_TITLES and sizesPrefixRe
    store.sizes[S_CODE_PRE + id] || 0,
    deepSize(scripts[i]),
    store.sizes[S_VALUE_PRE + id] || 0,
    meta.require.reduce(getSizeForRequires, { len: 0, pathMap }).len,
    Object.values(meta.resources).reduce(getSizeForResources, { len: 0, pathMap }).len,
  ]);
}

function getSizeForRequires(accum, url) {
  accum.len += (store.sizes[S_REQUIRE_PRE + (accum.pathMap[url] || url)] || 0) + url.length;
  return accum;
}

function getSizeForResources(accum, url) {
  accum.len += (store.sizes[S_CACHE_PRE + (accum.pathMap[url] || url)] || 0) + url.length;
  return accum;
}

/** @return {?Promise<void>} only if something was removed, otherwise undefined */
export function checkRemove({ force } = {}) {
  const now = Date.now();
  const toKeep = [];
  const toRemove = [];
  store.scripts.forEach(script => {
    const { id, lastModified } = script.props;
    if (script.config.removed && (force || now - getInt(lastModified) > TIMEOUT_WEEK)) {
      toRemove.push(storage.code.toKey(id),
        storage.script.toKey(id),
        storage.value.toKey(id));
    } else {
      toKeep.push(script);
    }
  });
  if (toRemove.length) {
    store.scripts = toKeep;
    return storage.base.remove(toRemove);
  }
}

/** @return {string} */
function getUUID() {
  const rnd = new Uint16Array(8);
  window.crypto.getRandomValues(rnd);
  // xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx
  // We're using UUIDv4 variant 1 so N=4 and M=8
  // See format_uuid_v3or5 in https://tools.ietf.org/rfc/rfc4122.txt
  rnd[3] = rnd[3] & 0x0FFF | 0x4000; // eslint-disable-line no-bitwise
  rnd[4] = rnd[4] & 0x3FFF | 0x8000; // eslint-disable-line no-bitwise
  return '01-2-3-4-567'.replace(/\d/g, i => (rnd[i] + 0x1_0000).toString(16).slice(-4));
}

/**
 * @param {VMScript} script
 * @param {string} code
 * @return {Promise<VMScript[]>}
 */
async function saveScript(script, code) {
  const config = script.config || {};
  config.enabled = getInt(config.enabled);
  config.shouldUpdate = getInt(config.shouldUpdate);
  const props = script.props || {};
  let oldScript;
  if (!props.id) {
    store.storeInfo.id += 1;
    props.id = store.storeInfo.id;
  } else {
    oldScript = store.scriptMap[props.id];
  }
  props.uri = getNameURI(script);
  props.uuid = props.uuid || crypto.randomUUID?.() || getUUID();
  // Do not allow script with same name and namespace
  if (store.scripts.some(({ props: { id, uri } = {} }) => props.id !== id && props.uri === uri)) {
    throw i18n('msgNamespaceConflict');
  }
  if (oldScript) {
    script.config = { ...oldScript.config, ...config };
    script.props = { ...oldScript.props, ...props };
    const index = store.scripts.indexOf(oldScript);
    store.scripts[index] = script;
  } else {
    if (!props.position) {
      store.storeInfo.position += 1;
      props.position = store.storeInfo.position;
    } else if (store.storeInfo.position < props.position) {
      store.storeInfo.position = props.position;
    }
    script.config = config;
    script.props = props;
    store.scripts.push(script);
  }
  return storage.base.set({
    [storage.script.toKey(props.id)]: script,
    [storage.code.toKey(props.id)]: code,
  });
}

/** @return {Promise<void>} */
export async function updateScriptInfo(id, data) {
  const script = store.scriptMap[id];
  if (!script) throw null;
  script.props = { ...script.props, ...data.props };
  script.config = { ...script.config, ...data.config };
  script.custom = { ...script.custom, ...data.custom };
  await storage.script.setOne(id, script);
  return sendCmd('UpdateScript', { where: { id }, update: script });
}

/**
 * @param {string | {code:string, custom:VMScript.Custom}} src
 * @return {{ meta: VMScript.Meta, errors: string[] }}
 */
function parseMetaWithErrors(src) {
  const isObj = isObject(src);
  const custom = isObj && src.custom || getDefaultCustom();
  const meta = parseMeta(isObj ? src.code : src);
  const errors = [];
  testerBatch(errors);
  testScript('', { meta, custom });
  testerBatch();
  return {
    meta,
    errors: errors.length ? errors : null,
  };
}

/** @return {Promise<{ isNew?, update, where }>} */
export async function parseScript(src) {
  const { meta, errors } = parseMetaWithErrors(src);
  if (!meta.name) throw `${i18n('msgInvalidScript')}\n${i18n('labelNoName')}`;
  const result = {
    errors,
    update: {
      message: src.message == null ? i18n('msgUpdated') : src.message || '',
    },
  };
  let script;
  const oldScript = await getScript({ id: src.id, meta });
  if (oldScript) {
    if (src.isNew) throw i18n('msgNamespaceConflict');
    script = { ...oldScript };
    delete script[INFERRED];
  } else {
    ({ script } = newScript());
    result.isNew = true;
    result.update.message = i18n('msgInstalled');
  }
  script.config = {
    ...script.config,
    ...src.config,
    removed: 0, // force reset `removed` since this is an installation
  };
  script.custom = {
    ...script.custom,
    ...src.custom,
  };
  script.props = {
    ...script.props,
    lastModified: Date.now(),
    lastUpdated: Date.now(),
    ...src.props,
  };
  script.meta = meta;
  if (!getScriptHome(script) && isRemote(src.from)) {
    script.custom.homepageURL = src.from;
  }
  if (isRemote(src.url)) script.custom.lastInstallURL = src.url;
  if (src.position) script.props.position = +src.position;
  buildPathMap(script, src.url);
  await saveScript(script, src.code);
  fetchResources(script, src);
  Object.assign(result.update, script, src.update);
  result.where = { id: script.props.id };
  sendCmd('UpdateScript', result);
  pluginEvents.emit('scriptChanged', result);
  return result;
}

/** @return {Object} */
function buildPathMap(script, base) {
  const { meta } = script;
  const baseUrl = base || script.custom.lastInstallURL;
  const pathMap = baseUrl ? [
    ...meta.require,
    ...Object.values(meta.resources),
    meta.icon,
  ].reduce((map, key) => {
    if (key) {
      const fullUrl = getFullUrl(key, baseUrl);
      if (fullUrl !== key) map[key] = fullUrl;
    }
    return map;
  }, {}) : {};
  script.custom.pathMap = pathMap;
  return pathMap;
}

/** @return {Promise<?string>} resolves to error text if `resourceCache` is absent */
export async function fetchResources(script, resourceCache, reqOptions) {
  const { custom: { pathMap }, meta } = script;
  const snatch = (url, type, validator) => {
    if (!url || isDataUri(url)) return;
    url = pathMap[url] || url;
    const contents = resourceCache?.[type]?.[url];
    return contents != null && !validator
      ? storage[type].setOne(url, contents) && null
      : storage[type].fetch(url, reqOptions, validator).catch(err => err);
  };
  const errors = await Promise.all([
    ...meta.require.map(url => snatch(url, S_REQUIRE)),
    ...Object.values(meta.resources).map(url => snatch(url, S_CACHE)),
    isRemote(meta.icon) && snatch(meta.icon, S_CACHE, validateImage),
  ]);
  if (!resourceCache?.ignoreDepsErrors) {
    const error = errors.map(formatHttpError)::trueJoin('\n');
    if (error) {
      const message = i18n('msgErrorFetchingResource');
      sendCmd('UpdateScript', {
        update: { error, message },
        where: { id: script.props.id },
      });
      return `${message}\n${error}`;
    }
  }
}

/** @return {Promise<void>} resolves on success, rejects on error */
function validateImage(url, buf, type) {
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(new Blob([buf], { type }));
    const onDone = (e) => {
      URL.revokeObjectURL(blobUrl);
      if (e.type === 'load') resolve();
      else reject(`IMAGE_ERROR: ${url}`);
    };
    const image = new Image();
    image.onload = onDone;
    image.onerror = onDone;
    image.src = blobUrl;
  });
}

function formatHttpError(e) {
  return e && [e.status && `HTTP${e.status}`, e.url]::trueJoin(' ') || e;
}

let _vacuuming;
/**
 * @param {Object} [data]
 * @return {Promise<{errors:string[], fixes:number}>}
 */
export async function vacuum(data) {
  if (_vacuuming) return _vacuuming;
  let resolveSelf;
  _vacuuming = new Promise(r => { resolveSelf = r; });
  const noFetch = data && [];
  const sizes = {};
  const result = {};
  const toFetch = [];
  const keysToRemove = [];
  /** -1=untouched, 1=touched, 2(+scriptId)=missing */
  const status = {};
  const prefixRe = RegExp(`^(${[
    S_VALUE_PRE,
    S_CACHE_PRE,
    S_REQUIRE_PRE,
    S_CODE_PRE,
    S_MOD_PRE,
  ].join('|')})`);
  const prefixIgnoreMissing = [
    S_VALUE_PRE,
    S_MOD_PRE,
  ];
  const downloadUrls = {};
  const touch = (prefix, id, scriptId, pathMap) => {
    if (!id || pathMap && isDataUri(id)) {
      return 0;
    }
    const key = prefix + (pathMap?.[id] || id);
    const val = status[key];
    if (val < 0) {
      status[key] = 1;
      if (id !== scriptId) {
        status[S_MOD_PRE + id] = 1;
      }
      if (prefix !== S_MOD_PRE) {
        sizes[key] = deepSize(data[key]) + (prefix === S_VALUE_PRE ? 0 : key.length);
      }
    } else if (!val && !prefixIgnoreMissing.includes(prefix)) {
      status[key] = 2 + scriptId;
    }
  };
  if (!data) data = await storage.base.getMulti();
  data::forEachKey((key) => {
    if (prefixRe.test(key)) {
      status[key] = -1;
    }
  });
  store.sizes = sizes;
  store.scripts.forEach((script) => {
    const { meta, props } = script;
    const { icon } = meta;
    const { id } = props;
    const pathMap = script.custom.pathMap || buildPathMap(script);
    const updUrls = getScriptUpdateUrl(script, true);
    if (updUrls) {
      updUrls.forEach(url => touch(S_MOD_PRE, url, id));
      downloadUrls[id] = updUrls[0];
    }
    touch(S_CODE_PRE, id, id);
    touch(S_VALUE_PRE, id, id);
    meta.require.forEach(url => touch(S_REQUIRE_PRE, url, id, pathMap));
    meta.resources::forEachValue(url => touch(S_CACHE_PRE, url, id, pathMap));
    if (isRemote(icon)) touch(S_CACHE_PRE, icon, id, pathMap);
  });
  status::forEachEntry(([key, value]) => {
    if (value < 0) {
      // Removing redundant value
      keysToRemove.push(key);
    } else if (value >= 2) {
      // Downloading the missing code or resource
      const area = storage.forKey(key);
      const id = area.toId(key);
      const url = area.name === S_CODE ? downloadUrls[id] : id;
      if (noFetch) {
        noFetch.push(url || +id && getScriptPrettyUrl(getScriptById(id)) || key);
      } else if (url && area.fetch) {
        keysToRemove.push(S_MOD_PRE + url);
        toFetch.push(area.fetch(url).catch(err => `${
          getScriptName(getScriptById(+id || value - 2))
        }: ${
          formatHttpError(err)
        }`));
      }
    }
  });
  if (keysToRemove.length) {
    await storage.base.remove(keysToRemove); // Removing `mod` before fetching
    result.errors = (await Promise.all(toFetch)).filter(Boolean);
  }
  if (noFetch && noFetch.length) {
    console.warn('Missing required resources. Try vacuuming database in options.', noFetch);
  }
  _vacuuming = null;
  result.fixes = toFetch.length + keysToRemove.length;
  resolveSelf(result);
  return result;
}
