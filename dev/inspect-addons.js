'use strict'

// Diagnostics for the DSH Thunderbird bridge install: which profile is live and
// whether the add-on was scanned by the AddonManager.

const fs = require('fs')
const path = require('path')

const id = process.argv[2]
const profile = process.argv[3]
const out = { profile: path.basename(profile) }

const stat = (p) => (fs.existsSync(p) ? fs.statSync(p).mtime.toISOString() : null)
out.prefsMtime = stat(path.join(profile, 'prefs.js'))
out.sessionMtime = stat(path.join(profile, 'session.json'))
out.extensionsJsonMtime = stat(path.join(profile, 'extensions.json'))
out.installedDir = fs.existsSync(path.join(profile, 'extensions', id, 'manifest.json'))
out.hasParentLock = fs.existsSync(path.join(profile, 'parent.lock'))

const ej = path.join(profile, 'extensions.json')
if (fs.existsSync(ej)) {
  try {
    const json = JSON.parse(fs.readFileSync(ej, 'utf8'))
    const addons = json.addons || []
    out.addonCount = addons.length
    const entry = addons.find((a) => a.id === id)
    out.entry = entry
      ? {
          active: entry.active,
          userDisabled: entry.userDisabled,
          appDisabled: entry.appDisabled,
          location: entry.location,
          version: entry.version,
          signedState: entry.signedState,
          seen: entry.seen,
          foreignInstall: entry.foreignInstall,
        }
      : null
  } catch (error) {
    out.extensionsJsonError = String(error.message)
  }
}

const uj = path.join(profile, 'user.js')
out.userJsPrefs = fs.existsSync(uj)
  ? fs.readFileSync(uj, 'utf8').split(/\r?\n/).filter((l) => /signatures|autoDisable/.test(l))
  : null

console.log(JSON.stringify(out, null, 2))
