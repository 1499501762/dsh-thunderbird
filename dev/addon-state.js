const cb = arguments[arguments.length - 1]
;(async () => {
  const out = {}
  try {
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs')
    const addons = await AddonManager.getAddonsByIDs(['dsh-thunderbird-bridge@dsh.local'])
    const a = addons[0]
    out.present = !!a
    if (a) {
      Object.assign(out, {
        version: a.version,
        isActive: a.isActive,
        userDisabled: a.userDisabled,
        appDisabled: a.appDisabled,
        signedState: a.signedState,
        foreignInstall: a.foreignInstall,
        location: a.location && a.location.name,
        permissions: a.userPermissions ? a.userPermissions.permissions : null,
      })
    }
    try {
      const { AddonSettings } = ChromeUtils.importESModule('resource://gre/modules/AddonSettings.sys.mjs')
      out.REQUIRE_SIGNING = AddonSettings.REQUIRE_SIGNING
    } catch (e) {
      // the module moved between releases; the pref is the portable answer
      out.REQUIRE_SIGNING = Services.prefs.getBoolPref('xpinstall.signatures.required')
      out.addonSettingsNote = String((e && (e.message || e)) || e)
    }
  } catch (e) {
    out.error = String((e && (e.message || e)) || e)
  }
  cb(JSON.stringify(out))
})()
