import defaults from '#/common/options-defaults';
import { initHooks, sendCmd, normalizeKeys } from '.';
import { forEachEntry, objectGet, objectSet } from './object';

let options = {};
const hooks = initHooks();
const ready = (global.allOptions || Promise.resolve())
.then((data) => data || sendCmd('GetAllOptions', null, { retry: true }))
.then((data) => {
  delete global.allOptions;
  ready.indeed = true; // a workaround for inability to query native Promise state
  options = data;
  if (data) hooks.fire(data);
});

function getOption(key) {
  const keys = normalizeKeys(key);
  return objectGet(options, keys) ?? objectGet(defaults, keys);
}

function setOption(key, value) {
  // the updated options object will be propagated from the background script after a pause
  // so meanwhile the local code should be able to see the new value using options.get()
  objectSet(options, normalizeKeys(key), value);
  sendCmd('SetOptions', { key, value });
}

function updateOptions(data) {
  // Keys in `data` may be { flattened.like.this: 'foo' }
  const expandedData = {};
  data::forEachEntry(([key, value]) => {
    objectSet(options, key, value);
    objectSet(expandedData, key, value);
  });
  hooks.fire(expandedData);
}

export default {
  ready,
  get: getOption,
  set: setOption,
  update: updateOptions,
  hook: hooks.hook,
};
