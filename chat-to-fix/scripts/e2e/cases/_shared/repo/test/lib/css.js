// A tiny CSS reader for the tests: no @media, no nesting, no npm packages.
//   parseCss(text)                -> [{ selectors: ['.a', '.b:hover'], decls: { color: 'red' } }]
//   declarationsOf(text, '.a')    -> { color: 'red' } (later rules win), or undefined when no rule names it
//   selectorsOf(text)             -> every selector that appears
export function parseCss(text) {
  const clean = String(text).replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = re.exec(clean)) !== null) {
    const selectors = match[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean)
    const decls = {}
    for (const part of match[2].split(';')) {
      const colon = part.indexOf(':')
      if (colon < 0) continue
      const prop = part.slice(0, colon).trim().toLowerCase()
      if (prop !== '') decls[prop] = part.slice(colon + 1).trim().replace(/\s+/g, ' ')
    }
    rules.push({ selectors, decls })
  }
  return rules
}

export function declarationsOf(text, selector) {
  let found
  for (const rule of parseCss(text)) {
    if (rule.selectors.includes(selector)) found = { ...(found ?? {}), ...rule.decls }
  }
  return found
}

export const selectorsOf = (text) => parseCss(text).flatMap((rule) => rule.selectors)
