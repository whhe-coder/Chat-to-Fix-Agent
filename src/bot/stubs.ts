// Stand-ins for the DS Bot modules that chat-to-fix does not install (spec 5, 4.4). Each kept
// module calls these through `rt` at run time; this file is installed right after
// `diagnostics`, so the functions exist before any module that calls them.

const none = () => undefined

export function install(rt) {
  // DS Bot tags the model requests it makes itself (e.g. the part steward's), so the group
  // relay can tell "a request the plugin sent" from "a group message". Original semantics
  // of usage.js:574-584: a weak table keyed by the request's `messages` array.
  const tags = new WeakMap()
  const tagUsage = (messages, tag) => {
    if (messages !== null && typeof messages === 'object') tags.set(messages, tag)
    return messages
  }
  const ownRequest = options => tags.has(options?.messages)

  Object.assign(rt, {
    // usage.js
    ownRequest,
    tagUsage,
    // capabilities.js (delivery.js:84, groups.js:290/318, parts.js:817/1109)
    ensureCapabilities: none,
    // memory.js
    renewMemory: none,
    archiveGroupMemory: none,
    archiveBotMemory: none,
    // schedules.js
    moveSchedules: none,
    // secrets.js
    forgetBotSecrets: none,
    // privacy.js
    privateClash: none, // no private bots: never a clash
    checkPrivacyChange: none,
    checkNoPrivate: none,
    // images.js
    imagesForGroup: async () => [],
    // channel.js: the configured language, if any
    uiLanguage: () => rt.config?.language,
  })
}
