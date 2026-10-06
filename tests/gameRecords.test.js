import test from 'node:test'
import assert from 'node:assert/strict'
import { isReactive, reactive } from 'vue'
import { markRawGameRecord, replaceGameRecords } from '../src/data/gameRecords.js'

test('game records remain non-reactive inside a reactive library', () => {
  const game = markRawGameRecord({ appid: '1', achievements: [{ name: 'First' }] })
  const library = reactive([game])

  assert.equal(isReactive(library), true)
  assert.equal(isReactive(library[0]), false)
  assert.equal(isReactive(library[0].achievements), false)
})

test('replacing game records returns a reactive-ready array with raw replacements', () => {
  const original = reactive([
    markRawGameRecord({ appid: '1', unlockedCount: 0 }),
    markRawGameRecord({ appid: '2', unlockedCount: 0 }),
  ])
  const replacement = { appid: '2', unlockedCount: 4 }
  const next = reactive(replaceGameRecords(original, [[1, replacement]]))

  assert.notEqual(next, original)
  assert.equal(next[0], original[0])
  assert.equal(next[1], replacement)
  assert.equal(isReactive(next[1]), false)
})
