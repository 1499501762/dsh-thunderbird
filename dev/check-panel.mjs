// The panel is a single HTML file with one inline classic script; nothing on the
// normal toolchain would ever notice a syntax error in it, so check it here.
// Parsing only — no file is written and nothing is executed.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, '..', 'dsh-side', 'ui.html'), 'utf8')
const open = html.indexOf('<script>')
const close = html.indexOf('</script>', open)
if (open < 0 || close < 0) {
  console.error('ui.html has no inline script block')
  process.exit(1)
}
const code = html.slice(open + '<script>'.length, close)
const head = html.slice(0, open).split('\n').length
try {
  // eslint-disable-next-line no-new
  new vm.Script(code, { filename: 'ui.html-inline.js' })
  console.log('ui.html panel script parses OK (' + code.length + ' chars)')
} catch (error) {
  const stack = String(error.stack || '')
  const at = /ui\.html-inline\.js:(\d+)/.exec(stack)
  const line = at ? Number(at[1]) : null
  console.error('ui.html panel script SYNTAX ERROR: ' + error.message)
  if (line !== null) {
    console.error('  script line ' + line + '  ->  ui.html line ' + (head + line))
    const lines = code.split('\n')
    for (let i = Math.max(0, line - 3); i < Math.min(lines.length, line + 2); i++) {
      console.error('  ' + String(i + 1).padStart(5) + ' | ' + lines[i])
    }
  }
  process.exit(1)
}
