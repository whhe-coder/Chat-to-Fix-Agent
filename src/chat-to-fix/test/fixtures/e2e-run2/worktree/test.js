import { applyDiscount, formatPrice } from './src/price.js'
import { greet } from './src/greeting.js'

let failed = 0
function check(name, actual, expected) {
  if (actual === expected) console.log(`ok   ${name}`)
  else { failed += 1; console.log(`FAIL ${name}: expected ${expected}, got ${actual}`) }
}

check('greet', greet('Ann'), 'Hello, Ann!')
check('formatPrice', formatPrice(5), '$5.00')
check('applyDiscount(100, 10)', applyDiscount(100, 10), 90)
check('applyDiscount(80, 25)', applyDiscount(80, 25), 60)
process.exit(failed === 0 ? 0 : 1)
